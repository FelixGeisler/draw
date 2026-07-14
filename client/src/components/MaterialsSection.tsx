import { useRef, useState } from "react";
import { useAddMaterial, useDeleteMaterial, useMaterials } from "../hooks/useGoals";

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MaterialsSection({ goalId }: { goalId: number }) {
  const materials = useMaterials(goalId);
  const addMaterial = useAddMaterial(goalId);
  const deleteMaterial = useDeleteMaterial(goalId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onFilePicked(files: FileList | null) {
    setError(null);
    if (!files) return;
    try {
      for (const file of Array.from(files)) {
        await addMaterial.mutateAsync({ file });
      }
    } catch (e) {
      setError((e as Error).message);
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13, color: "var(--text-dim)" }}>
          📎 Materials (lectures, past exams, notes — context for AI planning)
        </strong>
        <span style={{ flex: 1 }} />
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.txt,.md"
          multiple
          style={{ display: "none" }}
          onChange={(e) => onFilePicked(e.target.files)}
        />
        <button onClick={() => fileInput.current?.click()} disabled={addMaterial.isPending}>
          {addMaterial.isPending ? "Uploading…" : "+ File"}
        </button>
      </div>
      {error && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 4 }}>{error}</div>}
      <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
        {materials.data?.map((m) => (
          <div
            key={m.id}
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
          >
            <span>{m.kind === "file" ? "📄" : "📝"}</span>
            {m.kind === "file" ? (
              <a
                href={`/api/materials/${m.id}/download`}
                style={{ color: "var(--accent)", flex: 1 }}
              >
                {m.filename}
              </a>
            ) : (
              <span style={{ flex: 1, color: "var(--text-dim)" }}>
                {m.noteText!.length > 90 ? `${m.noteText!.slice(0, 90)}…` : m.noteText}
              </span>
            )}
            <span style={{ color: "var(--text-dim)" }}>{formatSize(m.sizeBytes)}</span>
            <button style={{ padding: "2px 8px" }} onClick={() => deleteMaterial.mutate(m.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          placeholder="Add a note (e.g. 'exam is 60% multiple choice, chapters 3–5 matter most')"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ flex: 1, fontSize: 13 }}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && note.trim()) {
              await addMaterial.mutateAsync({ noteText: note.trim() });
              setNote("");
            }
          }}
        />
      </div>
    </div>
  );
}
