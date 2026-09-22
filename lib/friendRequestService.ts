import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "@/lib/firebase";

const functions = getFunctions(app);

export async function createFriendRequest(toUid: string): Promise<string> {
  const callable = httpsCallable<{ toUid: string }, { requestId: string }>(functions, "createFriendRequest");
  const result = await callable({ toUid });
  return result.data.requestId;
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  const callable = httpsCallable<{ requestId: string }, { status: string }>(functions, "acceptFriendRequest");
  await callable({ requestId });
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  const callable = httpsCallable<{ requestId: string }, { status: string }>(functions, "declineFriendRequest");
  await callable({ requestId });
}

export async function cancelFriendRequest(requestId: string): Promise<void> {
  const callable = httpsCallable<{ requestId: string }, { status: string }>(functions, "cancelFriendRequest");
  await callable({ requestId });
}
