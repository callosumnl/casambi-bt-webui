import { BookOpen, Copy, Download } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import { curlExample, DocOperation, exampleFromSchema, groupOperations, OpenApiDocument, resolve } from "@/lib/openapi";
import "./ApiDocs.css";

/** Browsable REST API reference generated from the server's own OpenAPI document. */
export default function ApiDocs() {
  const api = useMemo(() => new LocalApi(null), []);
  const [document, setDocument] = useState<OpenApiDocument | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => { api.request<OpenApiDocument>("/openapi.json").then(setDocument).catch(reason => setError(reason instanceof Error ? reason.message : t("Unable to load the API description."))); }, [api]);

  const baseUrl = `${window.location.origin}/api/v1`;
  const query = filter.trim().toLowerCase();
  const groups = document ? groupOperations(document)
    .map(group => ({ ...group, operations: group.operations.filter(operation => !query || `${operation.method} ${operation.path} ${operation.summary} ${operation.tag}`.toLowerCase().includes(query)) }))
    .filter(group => group.operations.length > 0) : [];

  return <div className="api-docs">
    <div className="section-heading"><div><p className="eyebrow"><BookOpen /> REST API // OPENAPI 3.1</p><h2>API <em>//</em> {t("REFERENCE")}</h2></div><a className="outline-button" href="/api/v1/openapi.json" download="casambi-bt-webgui-openapi.json"><Download /> OPENAPI.JSON</a></div>
    <section className="api-intro">
      <p>{t("Base URL")} <code>{baseUrl}</code>. {t("Every route below is also described in")} <a href="/api/v1/openapi.json">openapi.json</a>{t(", which tools such as Postman, Insomnia, or Swagger UI can import.")}</p>
      <p>{t("Authenticate with an API key in the")} <code>X-API-Key</code> {t("header (create one under")} <Link href="/admin">{t("Admin → REST API keys")}</Link>{t("), or with")} <code>Authorization: Bearer &lt;token&gt;</code> {t("using the token from")} <code>POST /auth/login</code> {t("(valid 8 hours). Brightness levels are 0–255.")}</p>
    </section>
    {error && <p className="live-warning">{error}</p>}
    {!document && !error && <p className="muted-copy">{t("Loading the API description…")}</p>}
    {document && <>
      <input className="api-filter" type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("Filter, e.g. scene, schedules, POST")} aria-label={t("Filter endpoints")} />
      {groups.length === 0 && <p className="muted-copy">{t("No endpoint matches “{filter}”.", { filter })}</p>}
      {groups.map(group => <section key={group.tag} className="api-group">
        <h3>{group.tag}</h3>{group.description && <p className="muted-copy">{group.description}</p>}
        {group.operations.map(operation => <OperationDetails key={operation.key} operation={operation} document={document} baseUrl={baseUrl} />)}
      </section>)}
    </>}
  </div>;
}

function OperationDetails({ operation, document, baseUrl }: { operation: DocOperation; document: OpenApiDocument; baseUrl: string }) {
  const [copied, setCopied] = useState(false);
  const curl = curlExample(operation, document, baseUrl);
  const copy = async () => { try { await navigator.clipboard.writeText(curl); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); } catch { /* Selecting the text still works. */ } };
  return <details className="api-operation">
    <summary><span className={`api-method ${operation.method}`}>{operation.method.toUpperCase()}</span><code>{operation.path}</code><span className="api-summary">{operation.summary}</span><span className={`api-role ${operation.role}`}>{operation.role.toUpperCase()}</span></summary>
    <div className="api-body">
      {operation.description && <p>{operation.description}</p>}
      {operation.parameters.length > 0 && <><h4>{t("PARAMETERS")}</h4><ul className="api-params">{operation.parameters.map(parameter => <li key={`${parameter.in}-${parameter.name}`}><code>{parameter.name}</code> <span>{parameter.in}{parameter.required ? t(", required") : ""}</span>{parameter.description && <> — {parameter.description}</>}</li>)}</ul></>}
      {operation.body && <><h4>{t("REQUEST BODY")}{operation.bodyRequired ? "" : t(" (OPTIONAL)")}</h4><p className="api-example-label">{t("Example")}</p><pre>{JSON.stringify(exampleFromSchema(operation.body, document), null, 2)}</pre><p className="api-example-label">{t("Schema")}</p><pre>{JSON.stringify(resolve(operation.body, document), null, 2)}</pre></>}
      <h4>{t("RESPONSES")}</h4><ul className="api-responses">{operation.responses.map(response => <li key={response.status}><b>{response.status}</b> {response.description}{response.schema && <code>{response.schema}</code>}</li>)}</ul>
      <h4>{t("EXAMPLE")}</h4><pre>{curl}</pre><button type="button" className="outline-button" onClick={() => void copy()}><Copy /> {copied ? t("COPIED") : t("COPY CURL")}</button>
    </div>
  </details>;
}
