// Bark 推送

export interface BarkMsg {
  title: string;
  body: string;
  group?: string;
}

/** BARK_URL 为设备完整地址，如 https://barktest-cf.bobocai.win/<key> */
export async function sendBark(barkUrl: string, msg: BarkMsg): Promise<void> {
  const payload: Record<string, string> = {
    title: msg.title,
    body: msg.body,
  };
  if (msg.group) payload["group"] = msg.group;
  const res = await fetch(barkUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`bark push failed: ${res.status} ${await res.text()}`);
}
