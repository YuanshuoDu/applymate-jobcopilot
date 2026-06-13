declare module "js-yaml" {
  export function load<T = unknown>(input: string): T;
  export function dump(obj: unknown): string;
}
