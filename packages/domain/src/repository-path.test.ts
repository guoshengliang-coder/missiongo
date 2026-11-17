import { expect, it } from "vitest";
import { isAbsoluteRepositoryPath } from "./repository-path.js";

it("accepts node-local POSIX, drive and UNC checkout paths without depending on the server OS", () => {
  for (const path of ["/home/user/repo", "/mnt/c/开发/my repo", "C:\\开发\\my repo", "d:/src/repo", "\\\\build-server\\repos\\project", "\\\\server\\share"]) {
    expect(isAbsoluteRepositoryPath(path), path).toBe(true);
  }
  for (const path of ["", "repo", "C:repo", "\\repo", "\\\\server", "\\\\?\\C:\\repo", "\\\\.\\pipe\\repo", "//?/C:/repo", "C:\\repo:stream", "C:\\repo\nnext", "/home/u\0", "/home/u\\repo"]) {
    expect(isAbsoluteRepositoryPath(path), path).toBe(false);
  }
});
