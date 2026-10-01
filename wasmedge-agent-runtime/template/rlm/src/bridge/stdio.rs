use std::io::{self, Read, Write};

pub(super) struct Stream;

impl Read for Stream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        // stdin does not carry FD_FDSTAT_SET_FLAGS rights in WasmEdge. Poll
        // readiness instead of changing its flags or blocking past a deadline.
        let subscriptions = [
            wasi::Subscription {
                userdata: 1,
                u: wasi::SubscriptionU {
                    tag: wasi::EVENTTYPE_FD_READ.raw(),
                    u: wasi::SubscriptionUU {
                        fd_read: wasi::SubscriptionFdReadwrite { file_descriptor: 0 },
                    },
                },
            },
            wasi::Subscription {
                userdata: 2,
                u: wasi::SubscriptionU {
                    tag: wasi::EVENTTYPE_CLOCK.raw(),
                    u: wasi::SubscriptionUU {
                        clock: wasi::SubscriptionClock {
                            id: wasi::CLOCKID_MONOTONIC,
                            timeout: 0,
                            precision: 0,
                            flags: 0,
                        },
                    },
                },
            },
        ];
        let mut events = [wasi::Event {
            userdata: 0,
            error: wasi::ERRNO_SUCCESS,
            type_: wasi::EVENTTYPE_CLOCK,
            fd_readwrite: wasi::EventFdReadwrite {
                nbytes: 0,
                flags: 0,
            },
        }; 2];
        // Both arrays contain two initialized entries with matching union tags.
        let count = unsafe {
            wasi::poll_oneoff(
                subscriptions.as_ptr(),
                events.as_mut_ptr(),
                subscriptions.len(),
            )
        }
        .map_err(errno)?;
        for event in &events[..count] {
            if event.userdata == 1 {
                if event.error != wasi::ERRNO_SUCCESS {
                    return Err(errno(event.error));
                }
                let iov = wasi::Iovec {
                    buf: buffer.as_mut_ptr(),
                    buf_len: buffer.len(),
                };
                // The buffer is exclusively borrowed for this read.
                return unsafe { wasi::fd_read(0, &[iov]) }.map_err(errno);
            }
        }
        Err(io::ErrorKind::WouldBlock.into())
    }
}

impl Write for Stream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let iov = wasi::Ciovec {
            buf: buffer.as_ptr(),
            buf_len: buffer.len(),
        };
        // The input remains valid throughout the synchronous write. The host
        // drains stdout continuously; its cell deadline bounds backpressure.
        unsafe { wasi::fd_write(1, &[iov]) }.map_err(errno)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn errno(error: wasi::Errno) -> io::Error {
    io::Error::from_raw_os_error(i32::from(error.raw()))
}
