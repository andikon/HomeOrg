export function errorCodeOf(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return "unknown";
}
