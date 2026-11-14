use std::rc::Rc;

use gtk::prelude::*;

use super::super::{
    coordinates::{NativePetLogicalOffset, NativePetLogicalPoint, NATIVE_PET_COORDINATE_SPACE},
    drag_motion::{native_pet_flush_drag_motion_sample, native_pet_record_drag_motion_sample},
    drag_runtime::{
        native_pet_commit_drag_update, NativePetDragCommitContext, NativePetDragRuntimeState,
    },
    drag_state::NativePetDragStateMachine,
    lifecycle::{
        native_pet_animation_after_drag_release, native_pet_animation_for_hover_state,
        native_pet_fallen_get_up_animation,
        native_pet_requested_animation_after_pointer_interaction,
        native_pet_should_block_pointer_interaction, NativePetLocalInteractionAnimationState,
    },
    physics::NativePetInertiaState,
    pointer_interaction::{
        native_pet_open_chat_click_matches, native_pet_open_chat_release_cancels_candidate,
        native_pet_pointer_cursor_name, native_pet_pointer_press_can_open_chat,
        native_pet_should_start_pointer_interaction,
        native_pet_window_local_pointer_tracking_position, NativePetOpenChatClick,
    },
    preset_behavior::{
        native_pet_fallen_get_up_preset_behavior_event,
        native_pet_new_preset_behavior_interaction_id,
        native_pet_start_preset_behavior_execute_step,
    },
    process::{emit_native_pet_sidecar_event, NativePetSidecarEvent},
    renderer::native_pet_pointer_hits_visible_pet,
    step_runtime::native_pet_interrupt_active_step_for_local_interaction,
    window_cursor::native_pet_apply_pointer_cursor,
    window_events::{native_pet_button_press_opens_chat, native_pet_event_time_ms},
    window_state::NativePetRuntimeState,
};
use super::NativePetWindowController;

impl NativePetWindowController {
    pub(super) fn connect_pointer_handlers(
        self: &Rc<Self>,
        window: &gtk::Window,
        drawing_area: &gtk::DrawingArea,
    ) {
        let controller = Rc::clone(self);
        drawing_area
            .connect_enter_notify_event(move |area, event| controller.pointer_enter(area, event));
        let controller = Rc::clone(self);
        drawing_area.connect_leave_notify_event(move |area, _| controller.pointer_leave(area));
        let controller = Rc::clone(self);
        drawing_area
            .connect_button_press_event(move |area, event| controller.pointer_press(area, event));
        let controller = Rc::clone(self);
        drawing_area
            .connect_motion_notify_event(move |area, event| controller.pointer_motion(area, event));
        let controller = Rc::clone(self);
        let window = window.downgrade();
        drawing_area.connect_button_release_event(move |area, event| {
            let Some(window) = window.upgrade() else {
                return glib::Propagation::Proceed;
            };
            controller.pointer_release(&window, area, event)
        });
    }

    fn preempt_agent_step(&self) {
        let response = native_pet_interrupt_active_step_for_local_interaction(
            &mut self.runtime.active_step_state.borrow_mut(),
        );
        if let Some(response) = response {
            let _ = emit_native_pet_sidecar_event(NativePetSidecarEvent::StepResponse(response));
        }
    }

    fn pointer_enter(
        &self,
        drawing_area: &gtk::DrawingArea,
        event: &gdk::EventCrossing,
    ) -> glib::Propagation {
        let NativePetRuntimeState {
            animation_playback,
            drag_state,
            inertia_state,
            lifecycle_action_targets,
            pet_animations,
            pointer_hovered,
            requested_animation,
            ..
        } = &self.runtime;
        let Self {
            pet_spritesheet, ..
        } = self;
        let is_dragging = drag_state.borrow().is_some();
        let is_inertia_active = inertia_state.borrow().is_some();
        let (local_x, local_y) = event.position();
        let pointer_hits_visible_pet = native_pet_pointer_hits_visible_pet(
            pet_spritesheet,
            pet_animations,
            animation_playback.get(),
            local_x,
            local_y,
        );
        pointer_hovered.set(pointer_hits_visible_pet);
        native_pet_apply_pointer_cursor(
            drawing_area,
            native_pet_pointer_cursor_name(pointer_hits_visible_pet, is_dragging),
        );
        if !is_dragging && !is_inertia_active {
            let mut playback = animation_playback.get();
            playback.set_lifecycle_animation(native_pet_animation_for_hover_state(
                lifecycle_action_targets.as_ref(),
                pet_animations.as_ref(),
                pointer_hits_visible_pet,
                false,
                false,
                requested_animation.get(),
                playback,
            ));
            animation_playback.set(playback);
        }

        glib::Propagation::Proceed
    }

    fn pointer_leave(&self, drawing_area: &gtk::DrawingArea) -> glib::Propagation {
        let NativePetRuntimeState {
            animation_playback,
            drag_state,
            inertia_state,
            lifecycle_action_targets,
            pet_animations,
            pointer_hovered,
            requested_animation,
            ..
        } = &self.runtime;
        pointer_hovered.set(false);
        let is_dragging = drag_state.borrow().is_some();
        let is_inertia_active = inertia_state.borrow().is_some();
        native_pet_apply_pointer_cursor(
            drawing_area,
            native_pet_pointer_cursor_name(false, is_dragging),
        );
        if !is_dragging && !is_inertia_active {
            let mut playback = animation_playback.get();
            playback.set_lifecycle_animation(native_pet_animation_for_hover_state(
                lifecycle_action_targets.as_ref(),
                pet_animations.as_ref(),
                false,
                false,
                false,
                requested_animation.get(),
                playback,
            ));
            animation_playback.set(playback);
        }

        glib::Propagation::Proceed
    }

    fn pointer_press(
        &self,
        drawing_area: &gtk::DrawingArea,
        event: &gdk::EventButton,
    ) -> glib::Propagation {
        let NativePetRuntimeState {
            animation_playback,
            active_step_state,
            drag_state,
            edge_runout_state,
            fallen_preset_behavior_recovery_state,
            inertia_state,
            lifecycle_action_targets,
            movement_action_targets,
            open_chat_click,
            pet_animations,
            requested_animation,
            scripted_walk_state,
            ..
        } = &self.runtime;
        let Self {
            pet_spritesheet,
            fallen_get_up_action_targets,
            window_position,
            ..
        } = self;
        let drag_debug = self.drag_debug;
        let mut playback = animation_playback.get();
        let (local_x, local_y) = event.position();
        let press_time_ms = native_pet_event_time_ms(event.time());
        let Some(press_position) = NativePetLogicalPoint::try_new(local_x, local_y) else {
            return glib::Propagation::Proceed;
        };
        let pointer_hits_visible_pet = native_pet_pointer_hits_visible_pet(
            pet_spritesheet,
            pet_animations,
            playback,
            local_x,
            local_y,
        );
        if pointer_hits_visible_pet {
            requested_animation.set(native_pet_requested_animation_after_pointer_interaction(
                requested_animation.get(),
                lifecycle_action_targets.as_ref().sleep(),
                lifecycle_action_targets.as_ref().idle(),
            ));
        }
        if native_pet_pointer_press_can_open_chat(pointer_hits_visible_pet, event.button()) {
            if native_pet_button_press_opens_chat(event.button(), event.event_type())
                || native_pet_open_chat_click_matches(
                    open_chat_click.get(),
                    press_time_ms,
                    press_position,
                )
            {
                open_chat_click.set(None);
                self.preempt_agent_step();
                let _ = emit_native_pet_sidecar_event(NativePetSidecarEvent::OpenChat);
                playback.set_animation_target(movement_action_targets.tap());
                animation_playback.set(playback);
                return glib::Propagation::Proceed;
            }

            open_chat_click.set(Some(NativePetOpenChatClick {
                time_ms: press_time_ms,
                position: press_position,
            }));
        } else {
            open_chat_click.set(None);
        }

        if !native_pet_should_start_pointer_interaction(pointer_hits_visible_pet) {
            return glib::Propagation::Proceed;
        }

        self.preempt_agent_step();
        scripted_walk_state.replace(None);
        let interaction_state =
            NativePetLocalInteractionAnimationState::from_playback(pet_animations, playback);
        if let Some(get_up_animation) =
            native_pet_fallen_get_up_animation(fallen_get_up_action_targets, interaction_state)
        {
            let interaction_id = fallen_preset_behavior_recovery_state
                .borrow_mut()
                .take()
                .map(|state| state.into_interaction_id())
                .unwrap_or_else(native_pet_new_preset_behavior_interaction_id);
            let _ = emit_native_pet_sidecar_event(NativePetSidecarEvent::PresetBehavior(
                native_pet_fallen_get_up_preset_behavior_event(
                    get_up_animation,
                    interaction_id.clone(),
                    pet_animations.as_ref(),
                ),
            ));
            native_pet_start_preset_behavior_execute_step(
                active_step_state.as_ref(),
                pet_animations.as_ref(),
                &mut playback,
                requested_animation.as_ref(),
                get_up_animation,
                movement_action_targets.as_ref().idle(),
                interaction_id.as_str(),
            );
            animation_playback.set(playback);
            inertia_state.replace(None);
            edge_runout_state.set(None);
            native_pet_apply_pointer_cursor(
                drawing_area,
                native_pet_pointer_cursor_name(true, false),
            );
            return glib::Propagation::Proceed;
        }

        if native_pet_should_block_pointer_interaction(interaction_state) {
            return glib::Propagation::Proceed;
        }

        native_pet_apply_pointer_cursor(drawing_area, native_pet_pointer_cursor_name(true, true));
        playback.set_animation_target(movement_action_targets.grab_start());
        animation_playback.set(playback);
        inertia_state.replace(None);
        edge_runout_state.set(None);

        let origin_position = window_position.get();
        let Some(press_cursor_position) =
            native_pet_window_local_pointer_tracking_position(origin_position, local_x, local_y)
        else {
            return glib::Propagation::Proceed;
        };
        let machine = NativePetDragStateMachine::begin_with_grab_offset(
            press_cursor_position,
            NativePetLogicalOffset {
                x: local_x,
                y: local_y,
            },
            native_pet_event_time_ms(event.time()),
        );
        let drag = NativePetDragRuntimeState::begin(drawing_area, event, machine);
        let grab_offset = drag.grab_offset();
        drag_state.replace(Some(drag));
        if drag_debug {
            eprintln!(
                "native-pet-drag-debug press cursor=({:.1},{:.1}) origin=({}, {}) offset=({:.1},{:.1}) space={}",
                press_cursor_position.x,
                press_cursor_position.y,
                origin_position.x,
                origin_position.y,
                grab_offset.x,
                grab_offset.y,
                NATIVE_PET_COORDINATE_SPACE.label(),
            );
        }

        glib::Propagation::Proceed
    }

    fn pointer_motion(
        &self,
        drawing_area: &gtk::DrawingArea,
        event: &gdk::EventMotion,
    ) -> glib::Propagation {
        let NativePetRuntimeState {
            animation_playback,
            drag_state,
            inertia_state,
            lifecycle_action_targets,
            pet_animations,
            pointer_hovered,
            requested_animation,
            ..
        } = &self.runtime;
        let Self {
            pet_spritesheet,
            window_position,
            ..
        } = self;
        event.request_motions();
        let is_dragging = {
            let mut drag_state = drag_state.borrow_mut();
            if let Some(state) = drag_state.as_mut() {
                let (local_x, local_y) = event.position();
                if let Some(cursor_position) = native_pet_window_local_pointer_tracking_position(
                    window_position.get(),
                    local_x,
                    local_y,
                ) {
                    native_pet_record_drag_motion_sample(
                        state.motion_mut(),
                        cursor_position,
                        native_pet_event_time_ms(event.time()),
                    );
                }
                true
            } else {
                false
            }
        };
        native_pet_apply_pointer_cursor(
            drawing_area,
            native_pet_pointer_cursor_name(pointer_hovered.get(), is_dragging),
        );

        if !is_dragging {
            let (local_x, local_y) = event.position();
            let pointer_hits_visible_pet = native_pet_pointer_hits_visible_pet(
                pet_spritesheet,
                pet_animations,
                animation_playback.get(),
                local_x,
                local_y,
            );
            let was_hovered = pointer_hovered.replace(pointer_hits_visible_pet);
            let is_inertia_active = inertia_state.borrow().is_some();
            native_pet_apply_pointer_cursor(
                drawing_area,
                native_pet_pointer_cursor_name(pointer_hits_visible_pet, false),
            );
            if was_hovered != pointer_hits_visible_pet && !is_inertia_active {
                let mut playback = animation_playback.get();
                playback.set_lifecycle_animation(native_pet_animation_for_hover_state(
                    lifecycle_action_targets.as_ref(),
                    pet_animations.as_ref(),
                    pointer_hits_visible_pet,
                    false,
                    false,
                    requested_animation.get(),
                    playback,
                ));
                animation_playback.set(playback);
            }
        }

        glib::Propagation::Proceed
    }

    fn pointer_release(
        &self,
        gtk_window: &gtk::Window,
        drawing_area: &gtk::DrawingArea,
        event: &gdk::EventButton,
    ) -> glib::Propagation {
        let NativePetRuntimeState {
            animation_playback,
            drag_state,
            edge_runout_state,
            inertia_state,
            movement_action_targets,
            open_chat_click,
            pet_animations,
            pet_facing,
            physics_params,
            pointer_hovered,
            ..
        } = &self.runtime;
        let Self {
            pet_spritesheet,
            pending_rest_position_save,
            window_position,
            ..
        } = self;
        let window_size = self.window_size;
        let drag_debug = self.drag_debug;
        let mut playback = animation_playback.get();
        let state = {
            let mut drag_state = drag_state.borrow_mut();
            if let Some(state) = drag_state.as_mut() {
                let (local_x, local_y) = event.position();
                if let Some(cursor_position) = native_pet_window_local_pointer_tracking_position(
                    window_position.get(),
                    local_x,
                    local_y,
                ) {
                    if let Some(update) = native_pet_flush_drag_motion_sample(
                        state.motion_mut(),
                        cursor_position,
                        native_pet_event_time_ms(event.time()),
                    ) {
                        let movement_adapter = self.movement_adapter(gtk_window);
                        native_pet_commit_drag_update(
                            state,
                            update,
                            NativePetDragCommitContext {
                                playback: &mut playback,
                                movement_action_targets: movement_action_targets.as_ref(),
                                pet_facing: pet_facing.as_ref(),
                                movement_adapter: &movement_adapter,
                                window_size,
                                drag_debug,
                            },
                        );
                    }
                }
            }
            drag_state.take()
        };

        if let Some(state) = state {
            let release = state.release(physics_params);
            let (release_x, release_y) = event.position();
            if release.was_dragging() {
                pending_rest_position_save.set(true);
                if let Some(release_position) = NativePetLogicalPoint::try_new(release_x, release_y)
                {
                    if open_chat_click.get().is_some_and(|previous| {
                        native_pet_open_chat_release_cancels_candidate(previous, release_position)
                    }) {
                        open_chat_click.set(None);
                    }
                }
            }

            let inertia = if release.was_dragging() {
                NativePetInertiaState::from_release(
                    window_position.get(),
                    release.release_velocity,
                    physics_params,
                )
            } else {
                None
            };
            let inertia_velocity = inertia.map(NativePetInertiaState::velocity);
            inertia_state.replace(inertia);
            edge_runout_state.set(None);
            playback.set_animation_target(native_pet_animation_after_drag_release(
                movement_action_targets.as_ref(),
                release.was_dragging(),
                inertia_velocity,
                pet_facing.get(),
            ));
            let pointer_hits_visible_pet = inertia_velocity.is_none() && {
                let (local_x, local_y) = event.position();
                native_pet_pointer_hits_visible_pet(
                    pet_spritesheet,
                    pet_animations,
                    playback,
                    local_x,
                    local_y,
                )
            };
            pointer_hovered.set(pointer_hits_visible_pet);
            native_pet_apply_pointer_cursor(
                drawing_area,
                native_pet_pointer_cursor_name(pointer_hits_visible_pet, false),
            );
            animation_playback.set(playback);
            if drag_debug {
                eprintln!(
                    "native-pet-drag-debug release phase={:?} cursor=({:.1},{:.1}) velocity=({:.1},{:.1}) speed={:.1} inertia={}",
                    release.phase_before_release,
                    release.last_cursor_position.x,
                    release.last_cursor_position.y,
                    release.release_velocity.x,
                    release.release_velocity.y,
                    release.release_velocity.speed(),
                    inertia_velocity.is_some(),
                );
            }
        }
        animation_playback.set(playback);

        glib::Propagation::Proceed
    }
}
