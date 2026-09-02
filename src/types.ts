export const MANIFEST_VERSION = 1 as const;

export type NestedRepo = {
  id: string;
  path: string;
  gitDir: string;
};

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  nested: NestedRepo[];
  overlay: {
    paths: string[];
    baseSha: string | null;
    overlaySha: string | null;
  };
};

export function emptyManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    nested: [],
    overlay: {
      paths: [],
      baseSha: null,
      overlaySha: null,
    },
  };
}
