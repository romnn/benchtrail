// The web-platform globals the page's core may use.
// The core is checked without DOM or Node types, so it cannot reach for either environment, and
// these are the few standard globals both provide.

declare class URL {
  constructor(url: string, base?: string);
  readonly href: string;
  readonly protocol: string;
}
