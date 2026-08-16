(() => {
	function pathKey(path) {
		const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:\//.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
	}

	function displayPath(path, workspace) {
		const value = typeof path === "string" ? path.trim() : "";
		if (!value) return "";
		const normalized = value.replace(/\\/g, "/");
		const root = typeof workspace === "string" ? workspace.replace(/\\/g, "/").replace(/\/+$/, "") : "";
		if (root && pathKey(normalized).startsWith(`${pathKey(root)}/`)) return normalized.slice(root.length + 1);
		return normalized;
	}

	function addPath(paths, path, workspace) {
		const display = displayPath(path, workspace);
		if (display) paths.set(pathKey(display), display);
	}

	function stripPythonComments(code) {
		const result = [...code];
		let quote = "";
		let triple = false;
		let escaped = false;
		for (let index = 0; index < code.length; index++) {
			const char = code[index];
			if (quote) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (char === "\\") {
					escaped = true;
					continue;
				}
				if (triple && code.slice(index, index + 3) === quote.repeat(3)) {
					index += 2;
					quote = "";
					triple = false;
				} else if (!triple && char === quote) {
					quote = "";
				}
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				triple = code.slice(index, index + 3) === char.repeat(3);
				if (triple) index += 2;
				continue;
			}
			if (char !== "#") continue;
			while (index < code.length && code[index] !== "\n") {
				result[index] = " ";
				index++;
			}
		}
		return result.join("");
	}

	function extractPathAssignments(code) {
		const assignments = new Map();
		const pattern = /(?:^|[;\n])[ \t]*([A-Za-z_]\w*)\s*=\s*(?:pathlib\.)?Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)/gi;
		for (const match of code.matchAll(pattern)) {
			const values = assignments.get(match[1]) || [];
			values.push({ index: match.index, path: match[2] });
			assignments.set(match[1], values);
		}
		return assignments;
	}

	function resolvePathVariable(assignments, variable, index) {
		const values = assignments.get(variable);
		if (!values) return undefined;
		for (let position = values.length - 1; position >= 0; position--) {
			if (values[position].index <= index) return values[position].path;
		}
		return undefined;
	}

	function detailMutationPaths(details) {
		const paths = [];
		if (Array.isArray(details?.mutatedPaths)) {
			for (const path of details.mutatedPaths) if (typeof path === "string") paths.push(path);
		}
		if (Array.isArray(details?.diffs)) {
			for (const diff of details.diffs) if (typeof diff?.path === "string") paths.push(diff.path);
		}
		return paths;
	}

	function groupSummary(group) {
		if (group.files.length === 1) return `${group.verb} ${group.files[0]}`;
		return `${group.verb} ${group.files.length} files`;
	}

	function pathsMatch(left, right) {
		const leftPath = left.replace(/\\/g, "/").toLocaleLowerCase();
		const rightPath = right.replace(/\\/g, "/").toLocaleLowerCase();
		return leftPath === rightPath || leftPath.endsWith(`/${rightPath}`) || rightPath.endsWith(`/${leftPath}`);
	}

	function analyzeIpythonActivities({ code = "", details, workspace = "" } = {}) {
		const source = stripPythonComments(code);
		const reads = new Map();
		const creates = new Map();
		const edits = new Map();
		const explicitMutations = new Set();
		const pathAssignments = extractPathAssignments(source);
		const readPositions = new Map();
		const unresolvedReadVariables = new Set();
		const unresolvedWriteVariables = new Set();

		const addExplicitMutation = (paths, path) => {
			addPath(paths, path, workspace);
			const display = displayPath(path, workspace);
			if (display) explicitMutations.add(pathKey(display));
		};
		const addRead = (path, index) => {
			addPath(reads, path, workspace);
			const display = displayPath(path, workspace);
			if (!display || !Number.isInteger(index)) return;
			const key = pathKey(display);
			const positions = readPositions.get(key) || [];
			positions.push(index);
			readPositions.set(key, positions);
		};

		for (const match of source.matchAll(/\*\*\* Add File:\s*([^\r\n]+)/g)) addExplicitMutation(creates, match[1]);
		for (const match of source.matchAll(/\*\*\* Update File:\s*([^\r\n]+)/g)) addExplicitMutation(edits, match[1]);

		for (const match of source.matchAll(/(?:pathlib\.)?Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)\.(?:mkdir|touch)\s*\(/gi)) {
			addExplicitMutation(creates, match[1]);
		}
		for (const match of source.matchAll(/(?:mkdir|touch)\(\s*(?:[rubf]{0,2})?["']([^"']+)["']/gi)) {
			addExplicitMutation(creates, match[1]);
		}
		for (const match of source.matchAll(/\b([A-Za-z_]\w*)\.(?:mkdir|touch)\s*\(/g)) {
			const path = resolvePathVariable(pathAssignments, match[1], match.index);
			if (path) addExplicitMutation(creates, path);
		}

		for (const match of source.matchAll(/(?:pathlib\.)?Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)\.(?:read_text|read_bytes|iterdir|glob|rglob)\s*\(/gi)) {
			addRead(match[1], match.index);
		}
		for (const match of source.matchAll(/\b([A-Za-z_]\w*)\.(?:read_text|read_bytes|iterdir|glob|rglob)\s*\(/g)) {
			const path = resolvePathVariable(pathAssignments, match[1], match.index);
			if (path) addRead(path, match.index);
			else unresolvedReadVariables.add(match[1]);
		}
		for (const match of source.matchAll(/(?:^|[^.\w])(?:read_text|read_bytes)\(\s*(?:[rubf]{0,2})?["']([^"']+)["']/gi)) {
			addRead(match[1], match.index);
		}
		for (const match of source.matchAll(/\bopen\(\s*(?:[rubf]{0,2})?["']([^"']+)["'](?:\s*,\s*(?:mode\s*=\s*)?["']([^"']*)["'])?/gi)) {
			const mode = match[2] || "r";
			if (/[wax+]/i.test(mode)) continue;
			addRead(match[1], match.index);
		}
		for (const match of source.matchAll(/\bopen\(\s*([A-Za-z_]\w*)(?:\s*,\s*(?:mode\s*=\s*)?["']([^"']*)["'])?/g)) {
			const mode = match[2] || "r";
			if (/[wax+]/i.test(mode)) continue;
			const path = resolvePathVariable(pathAssignments, match[1], match.index);
			if (path) addRead(path, match.index);
			else unresolvedReadVariables.add(match[1]);
		}
		for (const match of source.matchAll(/\b([A-Za-z_]\w*)\.open\(\s*(?:(?:mode\s*=\s*)?["']([^"']*)["'])?/g)) {
			const mode = match[2] || "r";
			if (/[wax+]/i.test(mode)) continue;
			const path = resolvePathVariable(pathAssignments, match[1], match.index);
			if (path) addRead(path, match.index);
			else unresolvedReadVariables.add(match[1]);
		}

		const writeTargets = new Map();
		const writePositions = new Map();
		const addWrite = (path, index) => {
			addPath(writeTargets, path, workspace);
			const display = displayPath(path, workspace);
			if (!display || !Number.isInteger(index)) return;
			const key = pathKey(display);
			const positions = writePositions.get(key) || [];
			positions.push(index);
			writePositions.set(key, positions);
		};
		for (const match of source.matchAll(/(?:pathlib\.)?Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)\.(?:write_text|write_bytes)\s*\(/gi)) {
			addWrite(match[1], match.index);
		}
		for (const match of source.matchAll(/\b([A-Za-z_]\w*)\.(?:write_text|write_bytes)\s*\(/g)) {
			const path = resolvePathVariable(pathAssignments, match[1], match.index);
			if (path) addWrite(path, match.index);
			else unresolvedWriteVariables.add(match[1]);
		}
		for (const match of source.matchAll(/(?:^|[^.\w])(?:write_text|write_bytes)\(\s*(?:[rubf]{0,2})?["']([^"']+)["']/gi)) {
			addWrite(match[1], match.index);
		}

		const mutationPaths = detailMutationPaths(details);
		const mutationDisplays = new Map();
		for (const path of mutationPaths) addPath(mutationDisplays, path, workspace);
		const unresolvedReadWrite = [...unresolvedReadVariables].some((variable) => unresolvedWriteVariables.has(variable));
		if (unresolvedReadWrite && mutationDisplays.size === 1) addRead(mutationDisplays.values().next().value);

		for (const [key, path] of writeTargets) {
			explicitMutations.add(key);
			const writes = writePositions.get(key) || [];
			const targetReads = readPositions.get(key) || [];
			const firstWrite = writes[0] ?? Number.POSITIVE_INFINITY;
			const readBeforeWrite = targetReads.some((index) => index < firstWrite);
			if (readBeforeWrite) {
				addPath(edits, path, workspace);
				continue;
			}
			addPath(creates, path, workspace);
			if (writes.length > 1) addPath(edits, path, workspace);
		}

		for (const match of source.matchAll(/replace_text\(\s*(?:path\s*=\s*)?["']([^"']+)["']/gi)) {
			addExplicitMutation(edits, match[1]);
		}
		for (const match of source.matchAll(/\bedit\(\s*path\s*=\s*["']([^"']+)["']/gi)) {
			addExplicitMutation(edits, match[1]);
		}
		for (const [key, path] of mutationDisplays) {
			if (!explicitMutations.has(key)) addPath(edits, path, workspace);
		}
		for (const key of creates.keys()) reads.delete(key);
		if (unresolvedReadVariables.size > 0 && reads.size === 0) reads.set("__unknown__", "a file");

		const groups = [
			{ verb: "Read", files: [...reads.values()] },
			{ verb: "Created", files: [...creates.values()] },
			{ verb: "Edited", files: [...edits.values()] },
		].filter((group) => group.files.length > 0);
		if (groups.length > 0) return { groups, summary: groups.map(groupSummary).join(" · ") };

		const sleepMatch = /(?:time\.sleep|asyncio\.sleep)\(\s*([\d.]+)|(?:^|[\s;&|])sleep\s+([\d.]+)/m.exec(code);
		return { groups: [], summary: sleepMatch ? `Slept ${sleepMatch[1] || sleepMatch[2]}s` : "Ran a command" };
	}

	function composeIpythonDiffs(input, diffs) {
		if (!Array.isArray(diffs) || diffs.length === 0) return [];
		const activities = analyzeIpythonActivities(input);
		const createdPaths = activities.groups.find((group) => group.verb === "Created")?.files || [];
		const editedPaths = activities.groups.find((group) => group.verb === "Edited")?.files || [];
		const consumed = new Set();
		const composed = [];
		for (const [index, diff] of diffs.entries()) {
			if (consumed.has(index) || typeof diff?.path !== "string") continue;
			const createdPath = createdPaths.find((path) => pathsMatch(diff.path, path));
			if (!createdPath) {
				composed.push({ ...diff, kind: diff.kind || "edit" });
				continue;
			}
			let finalDiff = diff;
			for (let candidate = index + 1; candidate < diffs.length; candidate++) {
				if (typeof diffs[candidate]?.path !== "string" || !pathsMatch(diff.path, diffs[candidate].path)) continue;
				consumed.add(candidate);
				finalDiff = diffs[candidate];
			}
			const wasEdited = editedPaths.some((path) => pathsMatch(diff.path, path));
			composed.push({ ...finalDiff, oldStr: "", startLine: 1, kind: wasEdited ? "create-edit" : "create" });
		}
		return composed;
	}

	globalThis.PrometheusToolSummary = { analyzeIpythonActivities, composeIpythonDiffs };
})();
