/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_VERSION?: string
  readonly VITE_BUILD_GIT_SHA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
