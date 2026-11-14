use std::{rc::Rc, time::Duration};

use gtk::prelude::*;

use super::super::{
    animation::{NativePetAnimationPlayback, NativePetRequestedAnimationState},
    bounds::native_pet_runtime_resolve_window_placement,
    control_runtime::{
        native_pet_apply_completed_play_action_behavior, native_pet_drain_control_runtime_requests,
        NativePetControlRuntimeState,
    },
    drag_motion::native_pet_take_drag_frame_update,
    drag_runtime::{native_pet_commit_drag_update, NativePetDragCommitContext},
    drag_state::NativePetDragPhase,
    edge_runout::{native_pet_advance_edge_runout, native_pet_edge_runout_after_inertia_step},
    frame_timing::{
        native_pet_frame_clock_time_ms, native_pet_frame_dt_seconds, native_pet_frame_elapsed_ms,
    },
    geometry::NativePetFacing,
    lifecycle::{
        native_pet_animation_for_velocity, native_pet_facing_for_velocity,
        native_pet_next_throw_outcome_seed, native_pet_requested_animation_for_control_animation,
    },
    physics::NativePetPhysicsPhase,
    position_state::{save_native_pet_position_state, should_persist_native_pet_rest_position},
    preset_behavior::{
        native_pet_fallen_recovery_state_after_throw_finish,
        native_pet_new_preset_behavior_interaction_uuid, native_pet_preset_behavior_interaction_id,
        native_pet_start_preset_behavior_execute_step,
        native_pet_throw_after_drag_finish_after_runout,
        native_pet_throw_after_drag_preset_behavior_event,
    },
    process::{
        emit_native_pet_sidecar_event, NativePetControlPoll, NativePetLayer, NativePetSidecarEvent,
    },
    scripted_walk::{native_pet_step_scripted_walk, NativePetScriptedWalkArrival},
    step_runtime::{
        native_pet_active_play_action_completion_behavior, native_pet_advance_active_step,
        native_pet_complete_active_step, native_pet_play_action_completion_behavior_for_response,
        native_pet_step_response_is_motion_timeout,
    },
    window_layer::native_pet_layer_for_scripted_walk,
    window_movement::native_pet_reconcile_visible_placement,
    window_state::NativePetRuntimeState,
    window_tick::{native_pet_advance_lifecycle_tick, NativePetLifecycleTickState},
};
use super::NativePetWindowController;

const NATIVE_PET_RUNTIME_TICK_MS: u64 = 16;
const NATIVE_PET_PLACEMENT_REFRESH_MS: u64 = 1_000;

#[derive(Clone, Copy)]
struct NativePetFrameMotion {
    is_dragging: bool,
    is_inertia_active: bool,
    is_edge_runout_active: bool,
    is_scripted_walk_active: bool,
}

impl NativePetFrameMotion {
    fn is_locked(self) -> bool {
        self.is_dragging
            || self.is_inertia_active
            || self.is_edge_runout_active
            || self.is_scripted_walk_active
    }
}

impl NativePetWindowController {
    pub(super) fn start_runtime_updates(
        self: &Rc<Self>,
        window: &gtk::Window,
        drawing_area: &gtk::DrawingArea,
    ) {
        let controller = Rc::clone(self);
        let window = window.downgrade();
        let drawing_area = drawing_area.downgrade();
        glib::timeout_add_local(
            Duration::from_millis(NATIVE_PET_RUNTIME_TICK_MS),
            move || {
                let (Some(window), Some(drawing_area)) = (window.upgrade(), drawing_area.upgrade())
                else {
                    return glib::ControlFlow::Break;
                };
                controller.tick(&window, &drawing_area)
            },
        );
    }

    fn apply_window_layer(&self, window: &gtk::Window, next_layer: NativePetLayer) {
        if self.window_layer.get() == next_layer {
            return;
        }
        window.set_keep_above(next_layer.keep_above());
        if let Some(layer_shell) = &self.layer_shell {
            layer_shell.set_layer(window, next_layer);
        }
        self.window_layer.set(next_layer);
    }

    fn tick(&self, gtk_window: &gtk::Window, drawing_area: &gtk::DrawingArea) -> glib::ControlFlow {
        let NativePetRuntimeState {
            animation_playback,
            idle_lifecycle_elapsed_ms,
            idle_presence_schedule_seed,
            lifecycle_action_targets,
            pet_animations,
            physics_params,
            pointer_hovered,
            requested_animation,
            task_presence_elapsed_ms,
            ..
        } = &self.runtime;
        let Self {
            last_frame_time,
            placement_refresh_elapsed_ms,
            ..
        } = self;
        let frame_time = glib::monotonic_time();
        let previous_frame_time = last_frame_time.replace(Some(frame_time));
        let elapsed_ms = native_pet_frame_elapsed_ms(previous_frame_time, frame_time);
        placement_refresh_elapsed_ms.set(
            placement_refresh_elapsed_ms
                .get()
                .saturating_add(elapsed_ms),
        );
        let frame_dt_seconds =
            native_pet_frame_dt_seconds(previous_frame_time, frame_time, physics_params);
        let mut playback = self.advance_agent_step(elapsed_ms);
        let is_dragging = self.advance_drag(gtk_window, &mut playback, frame_time);
        let is_inertia_active =
            !is_dragging && self.advance_inertia(gtk_window, &mut playback, frame_dt_seconds);
        let is_edge_runout_active = !is_dragging
            && !is_inertia_active
            && self.advance_edge_runout(&mut playback, elapsed_ms);
        let is_scripted_walk_active = !is_dragging
            && !is_inertia_active
            && !is_edge_runout_active
            && self.advance_scripted_walk(gtk_window, &mut playback, elapsed_ms);
        let motion = NativePetFrameMotion {
            is_dragging,
            is_inertia_active,
            is_edge_runout_active,
            is_scripted_walk_active,
        };
        self.reconcile_rest_position(gtk_window, motion);
        if self
            .poll_control(gtk_window, &mut playback, motion)
            .is_break()
        {
            return glib::ControlFlow::Break;
        }
        native_pet_advance_lifecycle_tick(NativePetLifecycleTickState {
            playback: &mut playback,
            pet_animations,
            lifecycle_action_targets: lifecycle_action_targets.as_ref(),
            requested_animation: requested_animation.as_ref(),
            pointer_hovered: pointer_hovered.as_ref(),
            idle_lifecycle_elapsed_ms: idle_lifecycle_elapsed_ms.as_ref(),
            idle_presence_schedule_seed: idle_presence_schedule_seed.as_ref(),
            task_presence_elapsed_ms: task_presence_elapsed_ms.as_ref(),
            elapsed_ms,
            is_dragging,
            is_inertia_active,
            is_edge_runout_active,
            is_scripted_walk_active,
        });
        animation_playback.set(playback);
        drawing_area.queue_draw();
        glib::ControlFlow::Continue
    }

    fn advance_agent_step(&self, elapsed_ms: u64) -> NativePetAnimationPlayback {
        let NativePetRuntimeState {
            animation_playback,
            active_step_state,
            lifecycle_action_targets,
            pet_animations,
            requested_animation,
            scripted_walk_state,
            ..
        } = &self.runtime;
        let (step_response, completed_play_action_behavior) = {
            let mut active_step_state = active_step_state.borrow_mut();
            let completion_behavior =
                native_pet_active_play_action_completion_behavior(&active_step_state);
            let response = native_pet_advance_active_step(&mut active_step_state, elapsed_ms);
            let completed_behavior = response.as_ref().and_then(|response| {
                native_pet_play_action_completion_behavior_for_response(
                    completion_behavior,
                    response,
                )
            });
            (response, completed_behavior)
        };
        if let Some(response) = step_response {
            if native_pet_step_response_is_motion_timeout(&response) {
                scripted_walk_state.replace(None);
                requested_animation.set(NativePetRequestedAnimationState::from(
                    lifecycle_action_targets.idle(),
                ));
            }
            let _ = emit_native_pet_sidecar_event(NativePetSidecarEvent::StepResponse(response));
        }
        let mut playback = animation_playback.get();
        if let Some(completion_behavior) = completed_play_action_behavior {
            native_pet_apply_completed_play_action_behavior(
                completion_behavior,
                pet_animations.as_ref(),
                lifecycle_action_targets.as_ref(),
                &mut playback,
                requested_animation.as_ref(),
            );
        }
        playback
    }

    fn advance_drag(
        &self,
        gtk_window: &gtk::Window,
        playback: &mut NativePetAnimationPlayback,
        frame_time: i64,
    ) -> bool {
        let NativePetRuntimeState {
            drag_state,
            movement_action_targets,
            pet_facing,
            ..
        } = &self.runtime;
        let window_size = self.window_size;
        let drag_debug = self.drag_debug;
        let drag_phase = {
            let mut phase = NativePetDragPhase::Idle;
            let mut drag_state = drag_state.borrow_mut();
            if let Some(state) = drag_state.as_mut() {
                phase = state.phase();
                let frame_time_ms = native_pet_frame_clock_time_ms(frame_time);
                if let Some(update) =
                    native_pet_take_drag_frame_update(state.motion_mut(), frame_time_ms)
                {
                    let movement_adapter = self.movement_adapter(gtk_window);
                    native_pet_commit_drag_update(
                        state,
                        update,
                        NativePetDragCommitContext {
                            playback,
                            movement_action_targets: movement_action_targets.as_ref(),
                            pet_facing: pet_facing.as_ref(),
                            movement_adapter: &movement_adapter,
                            window_size,
                            drag_debug,
                        },
                    );
                }
            }
            phase
        };
        !matches!(drag_phase, NativePetDragPhase::Idle)
    }

    fn advance_inertia(
        &self,
        gtk_window: &gtk::Window,
        playback: &mut NativePetAnimationPlayback,
        frame_dt_seconds: f64,
    ) -> bool {
        let NativePetRuntimeState {
            active_step_state,
            edge_runout_state,
            fallen_preset_behavior_recovery_state,
            inertia_state,
            lifecycle_action_targets,
            movement_action_targets,
            pet_animations,
            pet_facing,
            physics_params,
            requested_animation,
            throw_outcome_seed,
            ..
        } = &self.runtime;
        let Self {
            throw_after_drag_finish_targets,
            ..
        } = self;
        let window_size = self.window_size;
        let drag_debug = self.drag_debug;
        let mut inertia_state = inertia_state.borrow_mut();
        if let Some(state) = inertia_state.as_mut() {
            let movement_adapter = self.movement_adapter(gtk_window);
            let impact_velocity = state.velocity();
            let step = state.step(frame_dt_seconds, physics_params, |position| {
                native_pet_runtime_resolve_window_placement(position, window_size, None)
                    .placement
                    .position
            });
            let placement =
                native_pet_runtime_resolve_window_placement(step.position, window_size, None)
                    .placement;
            if step.velocity.x.abs() > 1.0 {
                pet_facing.set(if step.velocity.x > 0.0 {
                    NativePetFacing::Right
                } else {
                    NativePetFacing::Left
                });
            }
            movement_adapter.move_to(placement);
            if matches!(step.phase, NativePetPhysicsPhase::Inertia) {
                playback.set_animation_target(native_pet_animation_for_velocity(
                    movement_action_targets.as_ref(),
                    step.velocity,
                    pet_facing.get(),
                ));
                if drag_debug {
                    eprintln!(
                        "native-pet-drag-debug inertia dt={:.4}s position=({}, {}) velocity=({:.1},{:.1}) speed={:.1} clamped={}",
                        step.clamped_dt_seconds,
                        step.position.x,
                        step.position.y,
                        step.velocity.x,
                        step.velocity.y,
                        step.velocity.speed(),
                        step.hit_position_clamp,
                    );
                }
                true
            } else {
                inertia_state.take();
                let run_facing = native_pet_facing_for_velocity(impact_velocity, pet_facing.get());
                let throw_finish = native_pet_throw_after_drag_finish_after_runout(
                    run_facing,
                    throw_outcome_seed.get(),
                );
                let finish_animation =
                    throw_after_drag_finish_targets.animation_target(throw_finish);
                let interaction_uuid = native_pet_new_preset_behavior_interaction_uuid();
                let interaction_id = native_pet_preset_behavior_interaction_id(interaction_uuid);
                fallen_preset_behavior_recovery_state.replace(
                    native_pet_fallen_recovery_state_after_throw_finish(
                        throw_finish,
                        interaction_id.clone(),
                    ),
                );
                let _ = emit_native_pet_sidecar_event(NativePetSidecarEvent::PresetBehavior(
                    native_pet_throw_after_drag_preset_behavior_event(
                        throw_finish,
                        finish_animation,
                        interaction_id.clone(),
                        pet_animations.as_ref(),
                    ),
                ));
                throw_outcome_seed
                    .set(native_pet_next_throw_outcome_seed(throw_outcome_seed.get()));
                if let Some(runout) = native_pet_edge_runout_after_inertia_step(
                    movement_action_targets.as_ref(),
                    step.hit_position_clamp,
                    pet_facing.get(),
                    impact_velocity,
                    finish_animation,
                    interaction_uuid,
                    physics_params,
                ) {
                    edge_runout_state.set(Some(runout));
                } else {
                    native_pet_start_preset_behavior_execute_step(
                        active_step_state.as_ref(),
                        pet_animations.as_ref(),
                        playback,
                        requested_animation.as_ref(),
                        finish_animation,
                        lifecycle_action_targets.as_ref().idle(),
                        interaction_id.as_str(),
                    );
                }
                if drag_debug {
                    eprintln!(
                        "native-pet-drag-debug inertia-end dt={:.4}s position=({}, {}) clamped={}",
                        step.clamped_dt_seconds,
                        step.position.x,
                        step.position.y,
                        step.hit_position_clamp,
                    );
                }
                false
            }
        } else {
            false
        }
    }

    fn advance_edge_runout(
        &self,
        playback: &mut NativePetAnimationPlayback,
        elapsed_ms: u64,
    ) -> bool {
        let NativePetRuntimeState {
            active_step_state,
            edge_runout_state,
            lifecycle_action_targets,
            pet_animations,
            requested_animation,
            ..
        } = &self.runtime;
        if let Some(state) = edge_runout_state.get() {
            let step = native_pet_advance_edge_runout(state, elapsed_ms);
            edge_runout_state.set(step.next_state);
            if step.next_state.is_some() {
                playback.set_animation_target(step.animation);
            } else {
                let interaction_id = native_pet_preset_behavior_interaction_id(
                    state.preset_behavior_interaction_uuid,
                );
                native_pet_start_preset_behavior_execute_step(
                    active_step_state.as_ref(),
                    pet_animations.as_ref(),
                    playback,
                    requested_animation.as_ref(),
                    step.animation,
                    lifecycle_action_targets.as_ref().idle(),
                    interaction_id.as_str(),
                );
            }
            step.next_state.is_some()
        } else {
            false
        }
    }

    fn advance_scripted_walk(
        &self,
        gtk_window: &gtk::Window,
        playback: &mut NativePetAnimationPlayback,
        elapsed_ms: u64,
    ) -> bool {
        let NativePetRuntimeState {
            active_step_state,
            lifecycle_action_targets,
            movement_action_targets,
            pet_animations,
            pet_facing,
            requested_animation,
            scripted_walk_state,
            ..
        } = &self.runtime;
        let Self {
            preferences,
            window_position,
            ..
        } = self;
        let window_size = self.window_size;
        self.apply_window_layer(
            gtk_window,
            native_pet_layer_for_scripted_walk(
                NativePetLayer::from_always_on_top(preferences.get().always_on_top),
                scripted_walk_state.borrow().as_ref(),
            ),
        );
        let mut scripted_walk_state = scripted_walk_state.borrow_mut();
        if let Some(state) = scripted_walk_state.as_mut() {
            let movement_adapter = self.movement_adapter(gtk_window);
            let step = native_pet_step_scripted_walk(
                movement_action_targets.as_ref(),
                window_position.get(),
                state.target_position(),
                elapsed_ms,
            );
            let placement =
                native_pet_runtime_resolve_window_placement(step.position, window_size, None)
                    .placement;
            if step.movement_dx.abs() > 1.0 {
                pet_facing.set(if step.movement_dx > 0.0 {
                    NativePetFacing::Right
                } else {
                    NativePetFacing::Left
                });
            }
            movement_adapter.move_to(placement);
            playback.set_animation_target(step.animation);
            if step.finished {
                match state.advance_after_arrival(elapsed_ms) {
                    NativePetScriptedWalkArrival::Holding => {
                        let after_animation = state
                            .after_animation
                            .unwrap_or_else(|| lifecycle_action_targets.as_ref().idle());
                        playback.set_animation_target(after_animation);
                        true
                    }
                    NativePetScriptedWalkArrival::Advanced => true,
                    NativePetScriptedWalkArrival::Finished => {
                        let after_animation = state
                            .after_animation
                            .unwrap_or_else(|| lifecycle_action_targets.as_ref().idle());
                        let requested = native_pet_requested_animation_for_control_animation(
                            pet_animations,
                            after_animation,
                            lifecycle_action_targets.as_ref().idle(),
                        );
                        requested_animation.set(requested);
                        playback.restart_animation_target(after_animation);
                        *scripted_walk_state = None;
                        let step_response = {
                            let mut active_step_state = active_step_state.borrow_mut();
                            native_pet_complete_active_step(&mut active_step_state)
                        };
                        if let Some(response) = step_response {
                            let _ = emit_native_pet_sidecar_event(
                                NativePetSidecarEvent::StepResponse(response),
                            );
                        }
                        false
                    }
                }
            } else {
                true
            }
        } else {
            false
        }
    }

    fn reconcile_rest_position(&self, gtk_window: &gtk::Window, motion: NativePetFrameMotion) {
        let Self {
            layer_shell,
            preferences,
            position_state_path,
            pending_rest_position_save,
            window_position,
            window_monitor_index,
            placement_refresh_elapsed_ms,
            ..
        } = self;
        let window_size = self.window_size;
        let drag_debug = self.drag_debug;
        let NativePetFrameMotion {
            is_dragging,
            is_inertia_active,
            is_edge_runout_active,
            is_scripted_walk_active,
        } = motion;
        let is_motion_locked = motion.is_locked();
        if should_persist_native_pet_rest_position(
            pending_rest_position_save.get(),
            is_dragging,
            is_inertia_active,
            is_edge_runout_active,
            is_scripted_walk_active,
        ) {
            pending_rest_position_save.set(false);
            if preferences.get().remember_position {
                if let Err(error) = save_native_pet_position_state(
                    position_state_path.as_ref(),
                    window_position.get(),
                ) {
                    eprintln!("Lexora Buddy native pet position save failed: {error}");
                }
            }
        }

        if !is_motion_locked {
            let force_native_refresh = layer_shell.is_some()
                && placement_refresh_elapsed_ms.get() >= NATIVE_PET_PLACEMENT_REFRESH_MS;
            let movement_adapter = self.movement_adapter(gtk_window);
            native_pet_reconcile_visible_placement(
                &movement_adapter,
                window_position.get(),
                window_monitor_index.get(),
                window_size,
                force_native_refresh,
                drag_debug,
            );
            if force_native_refresh {
                placement_refresh_elapsed_ms.set(0);
            }
        }
    }

    fn poll_control(
        &self,
        gtk_window: &gtk::Window,
        playback: &mut NativePetAnimationPlayback,
        motion: NativePetFrameMotion,
    ) -> glib::ControlFlow {
        let NativePetRuntimeState {
            active_step_state,
            control_messages,
            drag_state,
            edge_runout_state,
            idle_lifecycle_elapsed_ms,
            idle_presence_schedule_seed,
            inertia_state,
            lifecycle_action_targets,
            pet_animations,
            pointer_hovered,
            requested_animation,
            scripted_walk_state,
            task_presence_elapsed_ms,
            ..
        } = &self.runtime;
        let Self {
            preferences,
            config_path,
            position_state_path,
            pending_rest_position_save,
            should_quit,
            window_position,
            window_monitor_index,
            ..
        } = self;
        let window_size = self.window_size;
        let is_motion_locked = motion.is_locked();
        let is_dragging_for_control_state = drag_state.borrow().is_some();
        let control_poll =
            native_pet_drain_control_runtime_requests(NativePetControlRuntimeState {
                active_step_state: active_step_state.as_ref(),
                control_messages: control_messages.as_ref(),
                pet_animations: pet_animations.as_ref(),
                lifecycle_action_targets: lifecycle_action_targets.as_ref(),
                playback,
                requested_animation: requested_animation.as_ref(),
                pointer_hovered: pointer_hovered.as_ref(),
                idle_lifecycle_elapsed_ms: idle_lifecycle_elapsed_ms.as_ref(),
                idle_presence_schedule_seed: idle_presence_schedule_seed.as_ref(),
                task_presence_elapsed_ms: task_presence_elapsed_ms.as_ref(),
                inertia_state: inertia_state.as_ref(),
                edge_runout_state: edge_runout_state.as_ref(),
                scripted_walk_state: scripted_walk_state.as_ref(),
                window_position,
                window_monitor_index,
                window_size,
                is_dragging: is_dragging_for_control_state,
                is_motion_locked,
                config_path: config_path.as_ref(),
                position_state_path: position_state_path.as_ref(),
                preferences,
                pending_rest_position_save,
                should_quit,
            });
        if matches!(control_poll, NativePetControlPoll::Disconnected) {
            gtk::main_quit();
            return glib::ControlFlow::Break;
        }
        if should_quit.get() {
            gtk::main_quit();
            return glib::ControlFlow::Break;
        }
        self.apply_window_layer(
            gtk_window,
            native_pet_layer_for_scripted_walk(
                NativePetLayer::from_always_on_top(preferences.get().always_on_top),
                scripted_walk_state.borrow().as_ref(),
            ),
        );

        glib::ControlFlow::Continue
    }
}
