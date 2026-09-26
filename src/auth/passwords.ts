import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as english from "@zxcvbn-ts/language-en";

const passwordEstimator = new ZxcvbnFactory({
  dictionary: {
    ...common.dictionary,
    ...english.dictionary,
  },
  graphs: common.adjacencyGraphs,
  translations: english.translations,
});

export interface PasswordIssue {
  category: "too_short" | "too_long" | "common";
  detail: string;
}

export function passwordIssue(password: string): PasswordIssue | undefined {
  const length = Array.from(password).length;

  if (length < 15) {
    return { category: "too_short", detail: "Password must be at least 15 characters." };
  }

  if (Buffer.byteLength(password, "utf8") > 1024) {
    return { category: "too_long", detail: "Password must be no longer than 1024 UTF-8 bytes." };
  }

  if (passwordEstimator.check(password).score < 3) {
    return {
      category: "common",
      detail: "Choose a less common password that is not easily guessed.",
    };
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

let dummyHash: Promise<string> | undefined;

export async function verifyPassword(
  password: string,
  storedHash: string | undefined,
): Promise<boolean> {
  const hashToCheck =
    storedHash ??
    (await (dummyHash ??= hashPassword(randomBytes(32).toString("base64url"))));
  const matches = await argon2.verify(hashToCheck, password);

  return storedHash !== undefined && matches;
}
