export function setting(name: string): string | undefined {
  return process.env[`NORI_${name}`]
}

export function databasePath(): string {
  return setting('DATABASE_PATH') || '.data/nori.sqlite'
}
