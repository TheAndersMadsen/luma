import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// `findBy*` and `waitFor` give up after 1 s by default, which a busy machine
// exceeds before the first render settles. They still return as soon as the
// element appears, so a passing test is no slower.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => cleanup());
