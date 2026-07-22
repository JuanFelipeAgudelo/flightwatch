export async function sendNtfyNotification(
  topic: string,
  title: string,
  message: string
): Promise<void> {
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "high",
    },
    body: message,
  });
}
