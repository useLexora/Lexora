use std::{cell::Cell, path::PathBuf, rc::Rc};

use gtk::prelude::*;

use crate::error::{BuddyError, BuddyResult};

use super::{
    assets::{load_default_app_icon, load_default_pet_animation_set, load_default_pet_spritesheet},
    bounds::{native_pet_runtime_initial_placement, native_pet_runtime_resolve_restored_placement},
    config::NativePetConfig,
    coordinates::{NativePetLogicalSize, NativePetPosition},
    geometry::native_pet_window_logical_size,
    layer_shell::{validate_layer_shell_availability, LayerShellApi},
    lifecycle::NativePetFallenGetUpActionTargets,
    position_state::{clear_native_pet_position_state, load_native_pet_position_state},
    preset_behavior::NativePetThrowAfterDragFinishTargets,
    process::{
        emit_native_pet_sidecar_event, NativePetLaunchConfig, NativePetLayer, NativePetSidecarEvent,
    },
    renderer::install_transparent_window_css,
    window_movement::NativePetWindowMovementAdapter,
    window_state::NativePetRuntimeState,
};

#[path = "window_draw.rs"]
mod draw;
#[path = "window_pointer.rs"]
mod pointer;
#[path = "window_runtime.rs"]
mod runtime;

const NATIVE_PET_DRAG_DEBUG_ENV: &str = "LEXORA_BUDDY_NATIVE_PET_DRAG_DEBUG";

struct NativePetWindowController {
    runtime: NativePetRuntimeState,
    pet_spritesheet: gdk_pixbuf::Pixbuf,
    throw_after_drag_finish_targets: NativePetThrowAfterDragFinishTargets,
    fallen_get_up_action_targets: NativePetFallenGetUpActionTargets,
    layer_shell: Option<LayerShellApi>,
    window_size: NativePetLogicalSize,
    preferences: Cell<NativePetConfig>,
    config_path: PathBuf,
    position_state_path: PathBuf,
    pending_rest_position_save: Cell<bool>,
    should_quit: Cell<bool>,
    window_layer: Cell<NativePetLayer>,
    window_position: Cell<NativePetPosition>,
    window_monitor_index: Cell<Option<i32>>,
    last_frame_time: Cell<Option<i64>>,
    placement_refresh_elapsed_ms: Cell<u64>,
    drag_debug: bool,
}

impl NativePetWindowController {
    fn movement_adapter<'a>(
        &'a self,
        window: &'a gtk::Window,
    ) -> NativePetWindowMovementAdapter<'a> {
        NativePetWindowMovementAdapter::new(
            window,
            self.layer_shell.as_ref(),
            &self.window_monitor_index,
            &self.window_position,
        )
    }
}

pub(super) fn run_native_pet_sidecar(config: NativePetLaunchConfig) -> BuddyResult<()> {
    let initial_layer = NativePetLayer::from_always_on_top(config.preferences.always_on_top);
    gtk::init().map_err(|error| BuddyError::Runtime(error.to_string()))?;

    let pet_animations = Rc::new(load_default_pet_animation_set()?);
    let throw_after_drag_finish_targets =
        NativePetThrowAfterDragFinishTargets::load_bundled(pet_animations.as_ref())?;
    let fallen_get_up_action_targets =
        NativePetFallenGetUpActionTargets::load_bundled(pet_animations.as_ref())?;
    let window_size = native_pet_window_logical_size(pet_animations.geometry());
    let window_width = window_size.width;
    let window_height = window_size.height;
    let gtk_window = gtk::Window::new(gtk::WindowType::Toplevel);
    gtk_window.set_title("Lexora");
    let app_icon = load_default_app_icon()?;
    gtk_window.set_icon(Some(&app_icon));
    gtk_window.set_default_size(window_width, window_height);
    gtk_window.set_size_request(window_width, window_height);
    gtk_window.set_resizable(false);
    gtk_window.set_decorated(false);
    gtk_window.set_app_paintable(true);
    gtk_window.set_keep_above(initial_layer.keep_above());
    gtk_window.set_accept_focus(false);
    gtk_window.set_focus_on_map(false);
    gtk_window.set_skip_taskbar_hint(true);
    gtk_window.set_skip_pager_hint(true);
    gtk_window.connect_delete_event(|_, _| {
        gtk::main_quit();
        glib::Propagation::Proceed
    });

    let layer_shell_api = LayerShellApi::load();
    validate_layer_shell_availability(initial_layer, layer_shell_api.is_some())?;
    let layer_shell = layer_shell_api;
    if !config.preferences.remember_position {
        clear_native_pet_position_state(&config.position_state_path)?;
    }
    let restored_position = if config.preferences.remember_position {
        match load_native_pet_position_state(&config.position_state_path) {
            Ok(position) => position,
            Err(error) => {
                eprintln!("Lexora Buddy native pet position state ignored: {error}");
                None
            }
        }
    } else {
        None
    };
    let initial_placement = restored_position
        .map(|position| native_pet_runtime_resolve_restored_placement(position, window_size))
        .unwrap_or_else(|| native_pet_runtime_initial_placement(window_size));
    let preferences = Cell::new(config.preferences);
    let config_path = config.config_path;
    let position_state_path = config.position_state_path;
    let pending_rest_position_save = Cell::new(false);
    let should_quit = Cell::new(false);
    let window_layer = Cell::new(initial_layer);
    let window_position = Cell::new(initial_placement.position);
    let window_monitor_index = Cell::new(initial_placement.monitor_index);
    if let Some(layer_shell) = layer_shell.as_ref() {
        layer_shell.configure_window(&gtk_window, initial_layer, initial_placement);
    } else {
        let position = initial_placement.position;
        gtk_window.move_(position.x, position.y);
    }

    if let Some(screen) = gtk::prelude::WidgetExt::screen(&gtk_window) {
        install_transparent_window_css(&screen);
    }

    let drawing_area = gtk::DrawingArea::new();
    drawing_area.set_size_request(window_width, window_height);
    drawing_area.set_events(
        gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::ENTER_NOTIFY_MASK
            | gdk::EventMask::LEAVE_NOTIFY_MASK
            | gdk::EventMask::POINTER_MOTION_MASK,
    );

    gtk_window.add(&drawing_area);

    let pet_spritesheet = load_default_pet_spritesheet()?;
    let controller = Rc::new(NativePetWindowController {
        runtime: NativePetRuntimeState::new(pet_animations)?,
        pet_spritesheet,
        throw_after_drag_finish_targets,
        fallen_get_up_action_targets,
        layer_shell,
        window_size,
        preferences,
        config_path,
        position_state_path,
        pending_rest_position_save,
        should_quit,
        window_layer,
        window_position,
        window_monitor_index,
        last_frame_time: Cell::new(None),
        placement_refresh_elapsed_ms: Cell::new(0),
        drag_debug: std::env::var_os(NATIVE_PET_DRAG_DEBUG_ENV).is_some(),
    });
    controller.connect_draw(&drawing_area);
    controller.connect_pointer_handlers(&gtk_window, &drawing_area);
    controller.start_runtime_updates(&gtk_window, &drawing_area);

    gtk_window.show_all();
    emit_native_pet_sidecar_event(NativePetSidecarEvent::Ready)?;
    gtk::main();
    Ok(())
}
