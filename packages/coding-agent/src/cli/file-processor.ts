/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.js";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** A `@file` argument that cannot be used: missing, unreadable, or undecodable.
 *
 *  Thrown rather than exited on. This runs inside main(), after startup has
 *  collected deprecation warnings that interactive mode deliberately holds
 *  back to show inside the TUI -- which this failure means is never reached.
 *  A process.exit(1) here took the whole set to the grave, including the
 *  both-directories warning, whose entire subject is that the user's
 *  credentials, settings and sessions are in a tree the agent no longer reads.
 *  main() owns the exit and reports them first; this owns the message.
 *
 *  Everything below the access() check is wrapped in one, not only the causes
 *  with an obvious name. access() answers about the path; every read after it
 *  answers about the file, and those are different questions. A file whose
 *  mode denies reading passes access(F_OK) and then fails inside MIME
 *  detection, which opens every nonempty file before the text read is ever
 *  reached. An unwrapped error there escapes prepareInitialMessage's
 *  instanceof check and takes the warnings down with it -- which is the exact
 *  failure this class exists to prevent, arriving by a different door. */
export class FileArgumentError extends Error {}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			throw new FileArgumentError(`File not found: ${absolutePath}`);
		}

		// Every failure from here on is the file's, not the path's, and all of
		// them have to reach main()'s warning-aware exit as one kind of error.
		try {
			// Check if file is empty
			const stats = await stat(absolutePath);
			if (stats.size === 0) {
				// Skip empty files
				continue;
			}

			const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

			if (mimeType) {
				// Handle image file
				const content = await readFile(absolutePath);
				const base64Content = content.toString("base64");

				let attachment: ImageContent;
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
					if (!resized) {
						text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
						continue;
					}
					dimensionNote = formatDimensionNote(resized);
					attachment = {
						type: "image",
						mimeType: resized.mimeType,
						data: resized.data,
					};
				} else {
					attachment = {
						type: "image",
						mimeType,
						data: base64Content,
					};
				}

				images.push(attachment);

				// Add text reference to image with optional dimension note
				if (dimensionNote) {
					text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
				} else {
					text += `<file name="${absolutePath}"></file>\n`;
				}
			} else {
				// Handle text file
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			throw new FileArgumentError(`Could not read file ${absolutePath}: ${message}`);
		}
	}

	return { text, images };
}
