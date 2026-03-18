/// <reference types="vite/client" />

declare module "*.md?raw" {
  const content: string;
  export default content;
}

// Some linters don't correctly resolve the broad `*.md?raw` matcher for
// relative imports like `./data/example.md?raw`.
declare module "*./data/example.md?raw" {
  const content: string;
  export default content;
}

declare module "data/*.md?raw" {
  const content: string;
  export default content;
}

declare module "*data/example.md?raw" {
  const content: string;
  export default content;
}
