function configuredProxyList(): string[] {
  return (process.env.CLOAK_PROXY_LIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function getProxy(userId: string): string | null {
  const proxyList = configuredProxyList();
  if (proxyList.length === 0) {
    return process.env.CLOAK_PROXY_URL || null;
  }

  const idx = Math.abs(hashCode(userId)) % proxyList.length;
  return proxyList[idx] ?? null;
}
