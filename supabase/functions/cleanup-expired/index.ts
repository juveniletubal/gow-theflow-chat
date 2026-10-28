// Supabase Edge Function: remove expired messages and their uploaded media.
// Deploy with: supabase functions deploy cleanup-expired
// Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as Edge Function secrets.
// Never expose the service role key to the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // Optional shared secret for manual/scheduled invocation.
  const expected = Deno.env.get("CLEANUP_SECRET");
  if (expected && req.headers.get("x-cleanup-secret") !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return Response.json({ error: "Missing server secrets" }, { status: 500 });

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data: expired, error: readError } = await supabase
    .from("messages")
    .select("id,media_path")
    .lte("expires_at", new Date().toISOString())
    .limit(500);

  if (readError) return Response.json({ error: readError.message }, { status: 500 });
  if (!expired?.length) return Response.json({ deletedMessages: 0, deletedObjects: 0 });

  const paths = [...new Set(expired.map((m) => m.media_path).filter(Boolean))];
  let deletedObjects = 0;
  // Delete in manageable batches. Failed object deletes are reported; message rows are
  // retained for retry if media deletion fails, preventing orphaned objects.
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await supabase.storage.from("chat-media").remove(batch);
    if (error) return Response.json({ error: `Media deletion failed: ${error.message}`, deletedObjects }, { status: 500 });
    deletedObjects += batch.length;
  }

  const ids = expired.map((m) => m.id);
  const { error: deleteError } = await supabase.from("messages").delete().in("id", ids);
  if (deleteError) return Response.json({ error: deleteError.message, deletedObjects }, { status: 500 });

  return Response.json({ deletedMessages: ids.length, deletedObjects });
});
