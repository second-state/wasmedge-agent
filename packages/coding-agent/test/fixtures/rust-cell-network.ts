/** WasmEdge socket v1 ABI, without adding a networking crate to the template. */
export function socketClient(port: number): string {
	return `#[repr(C)] struct Address { buf: *const u8, size: usize }
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn sock_open(family: u32, kind: u32, fd: *mut u32) -> u32;
    fn sock_connect(fd: u32, address: *mut Address, port: u32) -> u32;
}
pub fn connect() {
    let mut fd = 0;
    let ip = [127u8, 0, 0, 1];
    let mut address = Address { buf: ip.as_ptr(), size: ip.len() };
    unsafe {
        assert_eq!(sock_open(1, 2, &mut fd), 0);
        assert_eq!(sock_connect(fd, &mut address, ${port}), 0);
    }
}`;
}
