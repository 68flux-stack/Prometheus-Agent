import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead, truncateTail } from "./truncate.js";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	tempDirectory?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string, directory: string): string {
	const id = randomBytes(8).toString("hex");
	return join(directory, `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	let end = Math.min(buffer.length, maxBytes);
	while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly tempDirectory: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private headText = "";
	private headBytes = 0;
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private totalLines = 1;
	private currentLineBytes = 0;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private tempFileError: Error | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.tempDirectory = options.tempDirectory ?? tmpdir();
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	snapshotHeadTail(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const marker = "\n[... output elided; middle removed ...]\n";
		const markerBytes = byteLength(marker);
		const contentBudget = Math.max(0, this.maxBytes - markerBytes);
		const headBudget = Math.floor(contentBudget * 0.4);
		const tailBudget = contentBudget - headBudget;
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		if (!truncated) return this.snapshot(options);
		const head = utf8Prefix(
			truncateHead(this.headText, { maxLines: this.maxLines, maxBytes: this.maxBytes }).content || this.headText,
			headBudget,
		);
		const tail = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: tailBudget }).content;
		const content = `${head}${marker}${tail}`;
		if (options.persistIfTruncated) this.ensureTempFile();
		return {
			content,
			truncation: {
				content,
				truncated: true,
				truncatedBy: this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines",
				totalLines: this.totalLines,
				totalBytes: this.totalDecodedBytes,
				outputLines: content.split("\n").length,
				outputBytes: byteLength(content),
				lastLinePartial: true,
				firstLineExceedsLimit: false,
				maxLines: this.maxLines,
				maxBytes: this.maxBytes,
			},
			fullOutputPath: this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		if (this.tempFileError) throw this.tempFileError;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("close", onClose);
				reject(error);
			};
			const onClose = () => {
				stream.off("error", onError);
				if (this.tempFileError) reject(this.tempFileError);
				else resolve();
			};
			stream.once("error", onError);
			stream.once("close", onClose);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		if (this.headBytes < this.maxBytes) {
			const remaining = this.maxBytes - this.headBytes;
			const buffer = Buffer.from(text, "utf8");
			let end = Math.min(buffer.length, remaining);
			while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
			const prefix = buffer.subarray(0, end).toString("utf8");
			this.headText += prefix;
			this.headBytes += byteLength(prefix);
		}
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
		} else {
			this.totalLines += newlines;
			this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix, this.tempDirectory);
		this.tempFileStream = createWriteStream(this.tempFilePath, { mode: 0o600 });
		this.tempFileStream.on("error", (error) => {
			this.tempFileError = error;
		});
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
