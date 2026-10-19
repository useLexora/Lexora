use std::{
    io::{self, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) struct Cancellation {
    cancelled: Arc<AtomicBool>,
    preparation_deadline: Instant,
}

impl Cancellation {
    pub(super) fn listen(mut input: impl Read + Send + 'static, budget: Duration) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        std::thread::spawn(move || {
            let mut byte = [0];
            let _ = input.read(&mut byte);
            flag.store(true, Ordering::Release);
        });
        Self {
            cancelled,
            preparation_deadline: Instant::now() + budget,
        }
    }

    pub(super) fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(super) fn check(&self) -> io::Result<()> {
        if self.cancelled() {
            Err(io::ErrorKind::Interrupted.into())
        } else if Instant::now() >= self.preparation_deadline {
            Err(io::ErrorKind::TimedOut.into())
        } else {
            Ok(())
        }
    }
}
