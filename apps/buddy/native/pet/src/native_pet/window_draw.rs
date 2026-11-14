use std::rc::Rc;

use gtk::prelude::*;

use super::super::renderer::{clear_transparent, draw_pet_frame};
use super::NativePetWindowController;

impl NativePetWindowController {
    pub(super) fn connect_draw(self: &Rc<Self>, drawing_area: &gtk::DrawingArea) {
        let controller = Rc::clone(self);
        drawing_area.connect_draw(move |_, context| {
            clear_transparent(context);
            draw_pet_frame(
                context,
                &controller.pet_spritesheet,
                &controller.runtime.pet_animations,
                controller.runtime.animation_playback.get(),
                controller.runtime.pet_facing.get(),
            );
            glib::Propagation::Proceed
        });
    }
}
