/**
 * The pay desk's view of the privacy service (agent/service_confidentialite.mjs):
 * a local process that seals the statement for the employee and the administration,
 * serves the zero-knowledge proof's public inputs, and plays the three readers —
 * the public, the administration, the employee. If it is not running the desk
 * says so and everything else still works: privacy is a layer, not a dependency.
 */
const SERVICE_URL = "http://127.0.0.1:8788";

export type ZkPublic = { commitment: string; total_cents: number; generated?: string; proof_bytes?: number; vk_sha256?: string };
export type SealResult = { ok: boolean; sha256_plain?: string; file_bytes?: number; recipients?: string[]; error?: string };
export type Role = "public" | "administration" | "employee";
export type View = { role: Role; ok: boolean; exit: number; lines: string[] };

/** The latest proof's public values, or undefined when the service is down or nothing was proven. */
export async function zkPublic(): Promise<ZkPublic | undefined> {
  try {
    const res = await fetch(`${SERVICE_URL}/zk`);
    if (!res.ok) return undefined;
    return (await res.json()) as ZkPublic;
  } catch {
    return undefined;
  }
}

/** Seal the statement, bound to the escrow that cites its hash. */
export async function seal(escrow: string): Promise<SealResult> {
  try {
    const res = await fetch(`${SERVICE_URL}/seal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escrow }),
    });
    return (await res.json()) as SealResult;
  } catch {
    return { ok: false, error: "privacy service not running (node agent/service_confidentialite.mjs)" };
  }
}

/** What a given reader sees of the escrow and the sealed statement. */
export async function view(role: Role, escrow: string): Promise<View> {
  try {
    const res = await fetch(`${SERVICE_URL}/view?role=${role}&escrow=${encodeURIComponent(escrow)}`);
    return (await res.json()) as View;
  } catch {
    return { role, ok: false, exit: -1, lines: ["privacy service not running (node agent/service_confidentialite.mjs)"] };
  }
}

/** Verify the zero-knowledge proof against the chain, as anyone can. */
export async function verifyProof(escrow: string): Promise<View> {
  try {
    const res = await fetch(`${SERVICE_URL}/verify?escrow=${encodeURIComponent(escrow)}`);
    return (await res.json()) as View;
  } catch {
    return { role: "public", ok: false, exit: -1, lines: ["privacy service not running (node agent/service_confidentialite.mjs)"] };
  }
}
