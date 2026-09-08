/**
 * A real package tarball, for tests that stand in for a release host.
 */

import { gzipSync } from "node:zlib";

/** One ustar entry: a 512-byte header, the content, and its padding. */
function tarEntry(name: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf-8");
	header.write("0000644\0", 100, 8, "utf-8");
	header.write("0000000\0", 108, 8, "utf-8");
	header.write("0000000\0", 116, 8, "utf-8");
	header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf-8");
	header.write(
		`${Math.floor(Date.now() / 1000)
			.toString(8)
			.padStart(11, "0")}\0`,
		136,
		12,
		"utf-8",
	);
	// The checksum is computed with its own field read as spaces, then written
	// over them.
	header.write("        ", 148, 8, "utf-8");
	header.write("0", 156, 1, "utf-8");
	header.write("ustar\0", 257, 6, "utf-8");
	header.write("00", 263, 2, "utf-8");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf-8");
	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return Buffer.concat([header, content, padding]);
}

/** Packs `manifest` as a tarball the update path can unpack.
 *
 *  Bytes with the right digest used to be enough for these tests, because the
 *  only thing done with them was to hand the file to npm. They are unpacked
 *  now: the package's own dependencies name the release's other packages, and
 *  those have to be verified too, so a fixture has to be a package rather
 *  than a string that hashes correctly.
 *
 *  Written here rather than shelled out to tar, because the tests that need
 *  one mock child_process to watch the install commands, and a fixture is not
 *  worth a hole in that mock.
 */
export function packReleaseTarball(
	manifest: Record<string, unknown> = { name: "wasmedge-agent", version: "99.0.0" },
): Buffer {
	const content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
	// Two zero blocks end an archive; tar warns about a truncated one.
	return gzipSync(Buffer.concat([tarEntry("package/package.json", content), Buffer.alloc(1024)]));
}
