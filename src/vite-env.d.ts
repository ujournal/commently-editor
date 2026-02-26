/// <reference types="vite/client" />

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "data/*.md?raw" {
  const content: string;
  export default content;
}
