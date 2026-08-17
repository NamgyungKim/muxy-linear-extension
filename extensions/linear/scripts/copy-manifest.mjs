import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// 배포에는 dist/ 만 포함되므로, 매니페스트(package.json)를 dist 로 복사해야
// 설치 가능한 자립형 확장이 된다. (public/assets 는 Vite 가 이미 복사함)
const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });
await copyFile(resolve(root, "package.json"), resolve(dist, "package.json"));
console.log("copied package.json -> dist/");
