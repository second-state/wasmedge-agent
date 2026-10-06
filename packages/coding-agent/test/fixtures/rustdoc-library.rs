#![allow(dead_code)]
pub mod skills;
mod hidden {
    pub struct Record<T> { pub value: T, secret: u8 }
    impl<T> Record<T> {
        pub fn new(value: T) -> Self { Self { value, secret: 0 } }
        pub fn get(&self) -> &T { &self.value }
        fn private_method(&self) {}
        pub const CAP: usize = 2;
    }
    pub trait Reader {
        type Item;
        const SIZE: usize;
        fn read(&self, value: Self::Item) -> bool;
    }
    pub enum Status { Ready, Value(u32), Named { code: i64 } }
    pub fn parse<'a, T: Clone>(value: &'a T) -> Result<T, String> { Ok(value.clone()) }
}
pub use hidden::{Record as Entry, Reader, Status, parse};
pub mod helpers { pub use crate::Entry as Nested; }
pub mod globbed { pub use crate::hidden::*; }
pub mod external { pub use std::io::*; }
pub fn r#type() {}
#[allow(non_snake_case)]
pub fn Shared() -> u32 { 1 }
pub struct Shared { pub value: u32 }
pub mod shadow {
    pub use crate::hidden::*;
    pub fn parse() -> u32 { 7 }
}
macro_rules! generate { () => { pub fn expanded(input: &[u8]) -> usize { input.len() } }; }
generate!();
#[cfg(target_os = "wasi")]
pub fn wasi_only() {}
#[cfg(not(target_os = "wasi"))]
pub fn native_only() {}
