import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from 'node:path';
import z from "zod";
import { getPiPackageDir, jsonDeepEqual, } from "./utils.ts";

const NonEmptyString = z.string().trim().min(1);
export class ConditionResult {
	ok : boolean;
	reason ? : string;
	constructor (ok : boolean, reason ?: string) {
		this.ok = ok;
		this.reason = reason;
	}
	andThen(other : () => ConditionResult) : ConditionResult {
		if(!this.ok) return this;
		return other();
	}

}
export interface Condition {
	readonly field : string;
	readonly eval : (rawInput : unknown, ctx : ExtensionContext) => ConditionResult;
}

export class Exists implements Condition {
	readonly field : string;
	private readonly returnTrue : boolean;
	readonly eval : (rawInput : unknown) => ConditionResult;
	constructor (field : string, returnTrue : boolean) {
		this.field = field;
		this.returnTrue = returnTrue;
		this.eval = (rawInput : unknown) => {
			const exists = (rawInput != null);
			let ok = (this.returnTrue && exists) || (!this.returnTrue && !exists);
			if(ok) return new ConditionResult(true);
			return new ConditionResult(false, `Param '${this.field}' needs to exist.`);
		};
	}
}
export const ExistsSchema = z.object({
	field: NonEmptyString,
	exists: z.boolean(),
}).transform(val => new Exists(val.field, val.exists));

export class EqualsAny implements Condition {
	readonly field : string;
	private readonly exists : Exists;
	private readonly valuesToCheck : unknown[];
	readonly eval : (rawInput : unknown) => ConditionResult;
	constructor (field : string, valuesToCheck : unknown[]) {
		this.field = field;
		this.exists = new Exists(this.field, true);
		this.valuesToCheck = valuesToCheck;
		this.eval = (rawInput : unknown) => {
			return this.exists.eval(rawInput).andThen(() => {
				if(this.valuesToCheck.some((value : unknown) => jsonDeepEqual(rawInput, value))) {
					return new ConditionResult(true);
				};
				return new ConditionResult(false, `${this.field} needs to be one of ${this.valuesToCheck}.`);
			});
		};
	}
}
export const EqualsAnySchema = z.object({
	field: NonEmptyString,
	equalsAny: z.array(z.unknown()).min(1),
}).transform(val => new EqualsAny(val.field, val.equalsAny));

export class MatchesAny implements Condition {
	readonly field : string;
	private readonly exists : Exists;
	private readonly patterns : RegExp[];
	readonly eval : (rawInput : unknown) => ConditionResult;
	constructor (field : string, patterns : RegExp[]) {
		this.field = field;
		this.exists = new Exists(this.field, true);
		this.patterns = patterns;
		this.eval = (rawInput : unknown) => {
			return this.exists.eval(rawInput).andThen(() => {
				if(typeof (rawInput) === "string") return new ConditionResult(true);
				return new ConditionResult(false, `${this.field} needs to be a string`);
			}).andThen(() => {
				if(this.patterns.some((pattern) => pattern.test(rawInput as string))) return new ConditionResult(true);
				return new ConditionResult(false, `${this.field} needs to match one of the patterns in ${this.patterns}.`);
			});
		};
	}
}
export const MatchesAnySchema = z.object({
	field: NonEmptyString,
	matchesAny: z.array(NonEmptyString).min(1),
}).transform((val, ctx) => {
	const patterns : RegExp[] = val.matchesAny.map(stringPattern => {
		try {
			return new RegExp(`^(?:${stringPattern})$`);
		} catch {
			ctx.issues.push({
				code: "custom",
				message: "Invalid regular expression.",
				input: stringPattern
			});
			return null;
		}
	}).filter(regExp => regExp != null);
	return new MatchesAny(val.field, patterns);
});

export class PathInAny implements Condition {
	readonly field : string;
	private readonly exists : Exists;
	private pathsToCheck : string[];
	private pathsNormalized : boolean;
	readonly eval : (rawInput : unknown, ctx : ExtensionContext) => ConditionResult;

	private static normalizePaths(path : string, ctx : ExtensionContext) {
		path = path.replace(/<env:cwd>/, ctx.cwd)
			.replace(/^<env:home>/, homedir())
			.replace(/^<env:pi_config_dir>/, getAgentDir())
			.replace(/^<env:pi_package_dir>/, getPiPackageDir());
		return resolve(path);
	}
	constructor (field : string, pathsToCheck : string[]) {
		this.field = field;
		this.exists = new Exists(this.field, true);
		this.pathsToCheck = pathsToCheck;
		this.pathsNormalized = false;
		this.eval = (rawInput : unknown, ctx : ExtensionContext) => {
			if(!this.pathsNormalized) {
				this.pathsToCheck = this.pathsToCheck.map(path => PathInAny.normalizePaths(path, ctx));
				this.pathsNormalized = true;
			}
			return this.exists.eval(rawInput).andThen(() => {
				if(typeof (rawInput) === "string") return new ConditionResult(true);
				return new ConditionResult(false, `${this.field} needs to be a string`);
			}).andThen(() => {
				if(this.pathsToCheck.some(path => {
					const rel = relative(path, resolve(rawInput as string));
					return (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)));
				})) return new ConditionResult(true);
				return new ConditionResult(false, `${this.field} needs to be inside one of the following paths: ${this.pathsToCheck}`);
			});
		};
	}
}
export const PathInAnySchema = z.object({
	field: NonEmptyString,
	pathInAny: z.array(NonEmptyString).min(1)
}).transform(val => new PathInAny(val.field, val.pathInAny));

export class PathMatchesAny implements Condition {
	readonly field : string;
	private readonly exists : Exists;
	private readonly patternsToCheck : RegExp[];
	readonly eval : (rawInput : unknown, ctx : ExtensionContext) => ConditionResult;

	constructor (field : string, patternsToCheck : RegExp[]) {
		this.field = field;
		this.exists = new Exists(field, true);
		this.patternsToCheck = patternsToCheck;
		this.eval = (rawInput : unknown) => {
			return this.exists.eval(rawInput).andThen(() => {
				if(typeof (rawInput) === "string") return new ConditionResult(true);
				return new ConditionResult(false, `${this.field} needs to be a string`);
			}).andThen(() => {
				if(this.patternsToCheck.some((regexp) => regexp.test(resolve(rawInput as string)))) {
					return new ConditionResult(true);
				}
				return new ConditionResult(false, `${this.field} needs to match one of ${this.patternsToCheck}.`);
			});
		};
	}
}
export const PathMatchesAnySchema = z.object({
	field: NonEmptyString,
	pathMatchesAny: z.array(NonEmptyString).min(1)
}).transform((val, ctx) => {
	const patterns : RegExp[] = val.pathMatchesAny.map(stringPattern => {
		try {
			return new RegExp(`^(?:${stringPattern})$`);
		} catch {
			ctx.issues.push({
				code: "custom",
				message: "Invalid regular expression.",
				input: stringPattern
			});
			return null;
		}
	}).filter(regExp => regExp != null);
	return new PathMatchesAny(val.field, patterns);
});
export const ConditionSchema = z.union([ ExistsSchema, MatchesAnySchema, EqualsAnySchema, PathMatchesAnySchema, PathInAnySchema ]);
