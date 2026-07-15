import { useMutation, useQueryClient } from "@tanstack/react-query";

export interface ImportSummary {
  tasks: number;
  goals: number;
  materials: number;
}

/**
 * Restore a backup archive (#61). Multipart, so it bypasses the JSON api
 * helper like material uploads do. A successful import replaced EVERYTHING
 * server-side — tasks, goals, materials, settings, gamification history, the
 * current draw — so every cached query is invalidated, not a curated list.
 */
export function useImportBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<ImportSummary> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/backup/import", { method: "POST", body: form });
      if (!res.ok) {
        let message = "restore failed";
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // non-JSON error body
        }
        throw new Error(message);
      }
      return res.json() as Promise<ImportSummary>;
    },
    onSuccess: () => qc.invalidateQueries(),
  });
}
