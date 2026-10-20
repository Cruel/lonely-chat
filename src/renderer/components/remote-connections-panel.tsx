import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type {
  RemoteCatalog,
  RemoteConnection,
  RemoteModelConfiguration,
} from '../../shared/remote-inference-contract';

const EMPTY: RemoteCatalog = { connections: [], models: [] };

function freshConnection(): RemoteConnection {
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'responses',
    credentialMode: 'managed',
    allowInsecureLan: false,
  };
}
function freshModel(connectionId: string): RemoteModelConfiguration {
  return {
    id: crypto.randomUUID(),
    name: '',
    connectionId,
    model: '',
    images: true,
    outputFormat: 'json-schema',
    allowRemoteImages: false,
  };
}

const field = 'w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm';
const smallLabel = 'block text-xs text-zinc-400 mb-1';

export function RemoteConnectionsPanel({
  onCatalog,
}: {
  onCatalog?: (value: RemoteCatalog) => void;
}) {
  const [catalog, setCatalog] = useState<RemoteCatalog>(EMPTY);
  const [connection, setConnection] = useState<RemoteConnection>(freshConnection);
  const [model, setModel] = useState<RemoteModelConfiguration | null>(null);
  const [secret, setSecret] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    const result = await window.lonelyChat?.listRemoteConfigurations?.();
    if (result) {
      setCatalog(result);
      onCatalog?.(result);
    }
  };
  useEffect(() => {
    void refresh().catch(() => {});
  }, []);

  const perform = async (action: () => Promise<void>) => {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remote configuration operation failed.');
    } finally {
      setWorking(false);
    }
  };
  const persistConnection = () =>
    perform(async () => {
      await window.lonelyChat!.saveRemoteConnection?.(connection);
      setNotice('Connection saved.');
    });
  const persistModel = () =>
    perform(async () => {
      if (!model) throw new Error('Select a Connection first.');
      await window.lonelyChat!.saveRemoteModel?.(model);
      setNotice('Model Configuration saved.');
    });

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-medium">Remote Connections</h3>
        <p className="mt-2 text-sm text-zinc-400">
          Configure OpenAI API and OpenAI-compatible endpoints. Only references and model settings
          are saved in ordinary configuration files; managed keys use protected OS storage when
          available, otherwise they last for this app session only.
        </p>
      </div>
      <div className="space-y-3">
        <label className={smallLabel} htmlFor="remote-connection">
          Connection
        </label>
        <select
          id="remote-connection"
          className={field}
          value={catalog.connections.some((v) => v.id === connection.id) ? connection.id : ''}
          onChange={(event) => {
            const next = catalog.connections.find((v) => v.id === event.target.value);
            if (next) {
              setConnection(next);
              setModel(null);
              setSecret('');
              setDiscovered([]);
            }
          }}
        >
          <option value="">New Connection</option>
          {catalog.connections.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <label className={smallLabel}>
          Name
          <Input
            className="mt-1"
            value={connection.name}
            onChange={(e) => setConnection({ ...connection, name: e.target.value })}
          />
        </label>
        <label className={smallLabel}>
          API base URL
          <Input
            className="mt-1"
            value={connection.baseUrl}
            onChange={(e) => setConnection({ ...connection, baseUrl: e.target.value })}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={smallLabel}>
            Protocol
            <select
              className={field}
              value={connection.protocol}
              onChange={(e) =>
                setConnection({
                  ...connection,
                  protocol: e.target.value as RemoteConnection['protocol'],
                })
              }
            >
              <option value="responses">Responses API</option>
              <option value="chat-completions">Chat Completions</option>
            </select>
          </label>
          <label className={smallLabel}>
            Credential source
            <select
              className={field}
              value={connection.credentialMode}
              onChange={(e) =>
                setConnection({
                  ...connection,
                  credentialMode: e.target.value as RemoteConnection['credentialMode'],
                  environmentVariable: undefined,
                })
              }
            >
              <option value="managed">Managed key (protected or session)</option>
              <option value="environment">Environment variable</option>
              <option value="none">No key (local servers)</option>
            </select>
          </label>
        </div>
        {connection.credentialMode === 'environment' && (
          <label className={smallLabel}>
            Environment variable name
            <Input
              className="mt-1"
              value={connection.environmentVariable ?? ''}
              onChange={(e) =>
                setConnection({ ...connection, environmentVariable: e.target.value })
              }
            />
          </label>
        )}
        <label className="flex items-start gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={connection.allowInsecureLan}
            onChange={(e) => setConnection({ ...connection, allowInsecureLan: e.target.checked })}
          />
          I acknowledge that HTTP on a private LAN sends prompts and any API credentials without
          transport encryption. TLS verification remains enabled for HTTPS.
        </label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={working} onClick={() => void persistConnection()}>
            Save Connection
          </Button>
          <Button
            variant="secondary"
            disabled={working}
            onClick={() => {
              setConnection(freshConnection());
              setModel(null);
              setSecret('');
            }}
          >
            New
          </Button>
          {catalog.connections.some((v) => v.id === connection.id) && (
            <Button
              variant="secondary"
              disabled={working}
              onClick={() =>
                void perform(async () => {
                  await window.lonelyChat!.deleteRemoteConnection?.(connection.id);
                  setConnection(freshConnection());
                  setModel(null);
                })
              }
            >
              Delete
            </Button>
          )}
        </div>
        {connection.credentialMode === 'managed' &&
          catalog.connections.some((v) => v.id === connection.id) && (
            <div>
              <label className={smallLabel}>
                API key (never returned from main)
                <Input
                  type="password"
                  autoComplete="off"
                  className="mt-1"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={working || !secret}
                  onClick={() =>
                    void perform(async () => {
                      const storage = await window.lonelyChat!.setRemoteCredential?.(
                        connection.id,
                        secret,
                      );
                      setSecret('');
                      setNotice(
                        storage === 'protected'
                          ? 'Key saved in protected OS storage.'
                          : 'Key is session-only; secure OS storage is unavailable.',
                      );
                    })
                  }
                >
                  Set credential
                </Button>
                <span className="text-xs text-zinc-400">
                  Current:{' '}
                  {catalog.connections.find((v) => v.id === connection.id)?.credentialStatus ??
                    'missing'}
                </span>
              </div>
            </div>
          )}
      </div>
      {catalog.connections.length > 0 && (
        <div className="space-y-3 border-t border-zinc-700 pt-5">
          <h4 className="font-medium">Model Configurations</h4>
          <select
            className={field}
            aria-label="Model Configuration"
            value={model?.id ?? ''}
            onChange={(e) => {
              const next = catalog.models.find((v) => v.id === e.target.value);
              setModel(next ?? null);
            }}
          >
            <option value="">New Model Configuration</option>
            {catalog.models.map((v) => (
              <option value={v.id} key={v.id}>
                {v.name} ({v.model})
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            disabled={working}
            onClick={() => setModel(freshModel(connection.id))}
          >
            New model
          </Button>
          {model && (
            <>
              <label className={smallLabel}>
                Configuration name
                <Input
                  className="mt-1"
                  value={model.name}
                  onChange={(e) => setModel({ ...model, name: e.target.value })}
                />
              </label>
              <label className={smallLabel}>
                Connection
                <select
                  className={field}
                  value={model.connectionId}
                  onChange={(e) => setModel({ ...model, connectionId: e.target.value })}
                >
                  {catalog.connections.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={smallLabel}>
                Remote model identifier
                <Input
                  list="remote-model-identifiers"
                  className="mt-1"
                  value={model.model}
                  onChange={(e) => setModel({ ...model, model: e.target.value })}
                />
                <datalist id="remote-model-identifiers">
                  {discovered.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </label>
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  void perform(async () => {
                    setDiscovered(
                      (await window.lonelyChat!.listRemoteModels?.(model.connectionId)) ?? [],
                    );
                    setNotice(
                      'Available model IDs retrieved from the endpoint (may be incomplete).',
                    );
                  })
                }
              >
                Discover models
              </Button>
              <label className={smallLabel}>
                Structured output compatibility
                <select
                  className={field}
                  value={model.outputFormat}
                  onChange={(e) =>
                    setModel({
                      ...model,
                      outputFormat: e.target.value as RemoteModelConfiguration['outputFormat'],
                    })
                  }
                >
                  <option value="json-schema">Strict JSON Schema</option>
                  <option value="json-object">JSON object</option>
                  <option value="prompt-json">Prompt-guided JSON</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={model.images}
                  onChange={(e) =>
                    setModel({
                      ...model,
                      images: e.target.checked,
                      allowRemoteImages: e.target.checked && model.allowRemoteImages,
                    })
                  }
                />
                This model supports images
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={model.allowRemoteImages}
                  disabled={!model.images}
                  onChange={(e) => setModel({ ...model, allowRemoteImages: e.target.checked })}
                />
                I explicitly authorize sending selected image frames to this model's remote endpoint
              </label>
              <div className="flex flex-wrap gap-2">
                <Button disabled={working} onClick={() => void persistModel()}>
                  Save Model Configuration
                </Button>
                {catalog.models.some((v) => v.id === model.id) && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() =>
                        void perform(async () => {
                          const result = await window.lonelyChat!.probeRemoteModel?.(model.id);
                          setNotice(
                            result?.compatible
                              ? 'Compatibility probe passed.'
                              : 'Compatibility probe unavailable.',
                          );
                        })
                      }
                    >
                      Probe protocol and JSON
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={working}
                      onClick={() =>
                        void perform(async () => {
                          await window.lonelyChat!.deleteRemoteModel?.(model.id);
                          setModel(null);
                        })
                      }
                    >
                      Delete model
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="text-sm text-zinc-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
