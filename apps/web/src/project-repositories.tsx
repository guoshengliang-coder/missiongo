import { useI18n } from "./i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ProjectRepository } from "./api";

export function ProjectRepositorySettings({ productId, writable }: { productId: string; writable: boolean }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const queryKey = ["project-repositories", productId];
  const list = useQuery({ queryKey, queryFn: () => api.projectRepositories(productId) });
  const [draft, setDraft] = useState<ProjectRepository | null>(null);
  const mutation = useMutation({
    mutationFn: async ({ action, entry }: { action: "save" | "archive"; entry: ProjectRepository }) => action === "archive"
      ? api.archiveProjectRepository(productId, entry.id)
      : api.saveProjectRepository(productId, { name: entry.name, repository: entry.repository, responsibility: entry.responsibility }, entry.id || undefined),
    onSuccess: async () => { setDraft(null); await client.invalidateQueries({ queryKey }); },
  });
  return <section className="product-settings-section">
    <h3>{t("projectRepositories")}</h3>
    {list.isError && <p role="alert">{list.error.message}</p>}
    <ul>{list.data?.map(entry => <li key={entry.id}>
      <strong>{entry.name}</strong> <code>{entry.repository}</code> {entry.responsibility}
      {writable && <button type="button" className="secondary-button" onClick={() => setDraft(entry)}>{t("edit")}</button>}
    </li>)}</ul>
    {writable && !draft && <button type="button" className="secondary-button" onClick={() => setDraft({ id: "", name: "", repository: "", responsibility: "" })}>{t("projectRepositoryAdd")}</button>}
    {writable && draft && <div className="product-settings-grid">
      <label>{t("projectRepositoryName")}<input value={draft.name} maxLength={100} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>{t("projectRepositoryRemote")}<input value={draft.repository} maxLength={500} readOnly={Boolean(draft.id)} onChange={event => setDraft({ ...draft, repository: event.target.value })} /></label>
      <label>{t("projectRepositoryResponsibility")}<input value={draft.responsibility} maxLength={500} onChange={event => setDraft({ ...draft, responsibility: event.target.value })} /></label>
      <div className="settings-form-footer">
        <button type="button" disabled={mutation.isPending} onClick={() => setDraft(null)}>{t("cancel")}</button>
        {draft.id && <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "archive", entry: draft })}>{t("projectRepositoryArchive")}</button>}
        <button type="button" className="primary-button" disabled={mutation.isPending || !draft.name.trim() || !draft.repository.trim()} onClick={() => mutation.mutate({ action: "save", entry: draft })}>{t("projectRepositorySave")}</button>
      </div>
    </div>}
    {mutation.isError && <p role="alert">{mutation.error.message}</p>}
  </section>;
}

export function RepositoryDevicePaths({ nodeId, productId }: { nodeId: string; productId: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const repositories = useQuery({ queryKey: ["project-repositories", productId], queryFn: () => api.projectRepositories(productId) });
  const queryKey = ["repository-paths", nodeId, productId];
  const paths = useQuery({ queryKey, queryFn: () => api.repositoryPaths(nodeId, productId), enabled: Boolean(repositories.data?.length) });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) => api.saveRepositoryPath(nodeId, productId, id, path.trim()),
    onSuccess: rows => client.setQueryData(queryKey, rows),
  });
  if (!repositories.data?.length) return null;
  return <div className="settings-product-section">
    {repositories.data.map(repository => {
      const saved = paths.data?.find(row => row.id === repository.id)?.repoPath ?? "";
      const value = drafts[repository.id] ?? saved;
      return <div key={repository.id} className="node-repo-choice">
        <label>{repository.name}<input value={value} onChange={event => setDrafts({ ...drafts, [repository.id]: event.target.value })} /></label>
        <button type="button" disabled={!paths.isSuccess || mutation.isPending || saved === value.trim()} onClick={() => mutation.mutate({ id: repository.id, path: value })}>{t("projectRepositorySavePath")}</button>
      </div>;
    })}
    {paths.isError && <p role="alert">{paths.error.message}</p>}
    {mutation.isError && <p role="alert">{mutation.error.message}</p>}
  </div>;
}
