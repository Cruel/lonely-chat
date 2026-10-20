import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Copy } from 'lucide-react';
import type { ChatGPTStatus, ChatGPTModel } from '../../shared/chatgpt-contract';
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
  const [chatGPT, setChatGPT] = useState<ChatGPTStatus>({
    secureStorageAvailable: true,
    persistCredentials: true,
    activeAccountId: null,
    accounts: [],
  });
  const [chatGPTModels, setChatGPTModels] = useState<ChatGPTModel[]>([]);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<RemoteConnection>(freshConnection);
  const [model, setModel] = useState<RemoteModelConfiguration | null>(null);
  const [secret, setSecret] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    const status = await window.lonelyChat?.getChatGPTStatus?.();
    if (status) setChatGPT(status);
    const result = await window.lonelyChat?.listRemoteConfigurations?.();
    if (result) {
      setCatalog(result);
      onCatalog?.(result);
    }
  };
  useEffect(() => {
    void refresh().catch(() => {});
  }, []);
  useEffect(() => {
    let mounted = true;
    let receivedUpdate = false;
    const unsubscribe = window.lonelyChat?.onChatGPTAuthorizationChange?.((url) => {
      receivedUpdate = true;
      setAuthorizationUrl(url);
    });
    void window.lonelyChat
      ?.getChatGPTAuthorizationUrl?.()
      .then((url) => {
        if (mounted && !receivedUpdate) setAuthorizationUrl(url);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    const selected = catalog.connections.find((entry) => entry.id === model?.connectionId);
    if (selected?.credentialMode === 'chatgpt' && selected.chatgptAccountId) {
      let active = true;
      void window.lonelyChat
        ?.listChatGPTModels?.(selected.chatgptAccountId)
        .then((entries) => {
          if (active) {
            setChatGPTModels(entries);
            setDiscovered(entries.map((entry) => entry.id));
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }
    setChatGPTModels([]);
    return;
  }, [model?.connectionId, catalog.connections]);

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
          Configure OpenAI API and OpenAI-compatible endpoints. Credentials are never included in
          ordinary configuration files or exports. They use secure OS storage when available, or a
          private local file otherwise.
        </p>
      </div>
      <div className="space-y-3 border-b border-zinc-700 pb-5">
        <h4 className="text-sm font-medium">ChatGPT plan accounts</h4>
        <p className="text-xs text-zinc-400">
          Eligible accounts can authorize plan inference separately from paid API keys. OpenAI plan
          limits apply; Lonely Chat never falls back to API billing.
        </p>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={chatGPT.persistCredentials}
            disabled={working}
            onChange={(event) => {
              const persist = event.currentTarget.checked;
              void perform(async () => {
                await window.lonelyChat!.setCredentialPersistence?.(persist);
                setNotice(
                  persist
                    ? 'Credential persistence enabled for ChatGPT and managed API keys.'
                    : 'Session-only: saved ChatGPT tokens and managed API keys were deleted.',
                );
              });
            }}
          />
          Remember ChatGPT authorization and managed API keys between restarts
        </label>
        {chatGPT.persistCredentials && !chatGPT.secureStorageAvailable && (
          <p role="status" className="text-xs text-amber-400">
            OS-protected storage is unavailable. Credentials will be saved in an application-private
            file (not encrypted at rest), readable by your OS user. Turn off Remember to keep them
            in memory only.
          </p>
        )}
        {!chatGPT.persistCredentials && (
          <p role="status" className="text-xs text-zinc-400">
            Session-only: credentials will be forgotten when Lonely Chat closes.
          </p>
        )}
        <select
          className={field}
          aria-label="ChatGPT account"
          value={chatGPT.activeAccountId ?? ''}
          onChange={(event) =>
            void perform(async () => {
              await window.lonelyChat!.selectChatGPTAccount?.(event.target.value);
            })
          }
        >
          <option value="">Select ChatGPT account</option>
          {chatGPT.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label} ({account.authorized ? account.storage : 'authorization needed'})
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={working}
            onClick={() =>
              void perform(async () => {
                const status = await window.lonelyChat!.signInChatGPT?.();
                if (status?.activeAccountId && connection.credentialMode === 'chatgpt')
                  setConnection({ ...connection, chatgptAccountId: status.activeAccountId });
                setNotice('ChatGPT sign-in completed. Select the account in a Connection.');
              })
            }
          >
            Continue with ChatGPT
          </Button>
          {authorizationUrl && (
            <span className="inline-flex items-center gap-1">
              <a
                href={authorizationUrl}
                className="text-xs text-primary underline underline-offset-4 hover:text-primary/80"
                title="Retry opening ChatGPT sign-in in your system browser"
                onClick={(event) => {
                  event.preventDefault();
                  void window.lonelyChat?.openChatGPTAuthorizationUrl?.().catch(() => {
                    setError('Unable to open the browser. Copy the sign-in link instead.');
                  });
                }}
              >
                Open sign-in link
              </a>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Copy ChatGPT sign-in link"
                title="Copy sign-in link to clipboard"
                onClick={() => {
                  void window.lonelyChat
                    ?.copyChatGPTAuthorizationUrl?.()
                    .then(() => setNotice('Sign-in link copied to clipboard.'))
                    .catch(() => setError('Unable to copy the ChatGPT sign-in link.'));
                }}
              >
                <Copy aria-hidden="true" />
              </Button>
            </span>
          )}
          {chatGPT.activeAccountId && (
            <>
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  void perform(async () => {
                    await window.lonelyChat!.signInChatGPT?.(chatGPT.activeAccountId!);
                    setNotice('ChatGPT account reauthorized.');
                  })
                }
              >
                Reauthorize
              </Button>
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  void perform(async () => {
                    const result = await window.lonelyChat!.signOutChatGPT?.(
                      chatGPT.activeAccountId!,
                    );
                    setNotice(
                      result?.revoked
                        ? 'ChatGPT session revoked.'
                        : 'Signed out locally. Remote revocation could not be confirmed; disconnect in ChatGPT Settings.',
                    );
                  })
                }
              >
                Sign out
              </Button>
            </>
          )}
        </div>
        {chatGPT.activeAccountId && (
          <p className="text-xs text-zinc-400">
            {chatGPT.accounts.find((a) => a.id === chatGPT.activeAccountId)?.email ?? 'Account'}
            {' · '}Plan usage:{' '}
            {chatGPT.accounts.find((a) => a.id === chatGPT.activeAccountId)?.authorized
              ? 'authorized'
              : 'needs authorization'}
          </p>
        )}
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
            setConnection(next ?? freshConnection());
            setModel(null);
            setSecret('');
            setDiscovered([]);
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
            disabled={connection.credentialMode === 'chatgpt'}
            onChange={(e) => setConnection({ ...connection, baseUrl: e.target.value })}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={smallLabel}>
            Protocol
            <select
              className={field}
              value={connection.protocol}
              disabled={connection.credentialMode === 'chatgpt'}
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
              onChange={(e) => {
                const chatgpt = e.target.value === 'chatgpt';
                setConnection({
                  ...connection,
                  credentialMode: e.target.value as RemoteConnection['credentialMode'],
                  environmentVariable: undefined,
                  chatgptAccountId: chatgpt ? (chatGPT.activeAccountId ?? undefined) : undefined,
                  ...(chatgpt
                    ? {
                        baseUrl: 'https://api.openai.com/v1',
                        protocol: 'responses' as const,
                        allowInsecureLan: false,
                      }
                    : {}),
                });
              }}
            >
              <option value="chatgpt">ChatGPT subscription (OAuth; no API billing)</option>
              <option value="managed">Managed key (protected, private file, or session)</option>
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
        {connection.credentialMode === 'chatgpt' && (
          <label className={smallLabel}>
            ChatGPT account for this Connection
            <select
              className={field}
              value={connection.chatgptAccountId ?? ''}
              onChange={(e) => setConnection({ ...connection, chatgptAccountId: e.target.value })}
            >
              <option value="">Select an authorized account</option>
              {chatGPT.accounts
                .filter((a) => a.authorized)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label}
                  </option>
                ))}
            </select>
          </label>
        )}
        {connection.credentialMode !== 'chatgpt' && (
          <label className="flex items-start gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={connection.allowInsecureLan}
              onChange={(e) => setConnection({ ...connection, allowInsecureLan: e.target.checked })}
            />
            I acknowledge that HTTP on a private LAN sends prompts and any API credentials without
            transport encryption. TLS verification remains enabled for HTTPS.
          </label>
        )}
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
                          ? 'Key saved with OS credential protection.'
                          : storage === 'file'
                            ? 'Key saved in an application-private file (not encrypted at rest).'
                            : 'Key is session-only and will not survive restart.',
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
              setModel(
                next
                  ? {
                      ...next,
                      ...(catalog.connections.some(
                        (entry) =>
                          entry.id === next.connectionId && entry.credentialMode === 'chatgpt',
                      )
                        ? { outputFormat: 'prompt-json' as const }
                        : {}),
                    }
                  : null,
              );
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
            onClick={() =>
              setModel({
                ...freshModel(connection.id),
                ...(connection.credentialMode === 'chatgpt'
                  ? { outputFormat: 'prompt-json' as const }
                  : {}),
              })
            }
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
                  onChange={(e) => {
                    const selected = catalog.connections.find(
                      (entry) => entry.id === e.target.value,
                    );
                    setModel({
                      ...model,
                      connectionId: e.target.value,
                      model: '',
                      ...(selected?.credentialMode === 'chatgpt'
                        ? { outputFormat: 'prompt-json' as const }
                        : {}),
                    });
                    setDiscovered([]);
                  }}
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
                  readOnly={catalog.connections.some(
                    (c) => c.id === model.connectionId && c.credentialMode === 'chatgpt',
                  )}
                  onChange={(e) => setModel({ ...model, model: e.target.value })}
                />
                <datalist id="remote-model-identifiers">
                  {discovered.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </label>
              {catalog.connections.some(
                (c) => c.id === model.connectionId && c.credentialMode === 'chatgpt',
              ) && (
                <select
                  className={field}
                  aria-label="Available ChatGPT plan model"
                  value={model.model}
                  onChange={(e) => setModel({ ...model, model: e.target.value })}
                >
                  <option value="">Choose from account catalog</option>
                  {chatGPTModels.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              )}
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  void perform(async () => {
                    const selectedConnection = catalog.connections.find(
                      (c) => c.id === model.connectionId,
                    );
                    if (
                      selectedConnection?.credentialMode === 'chatgpt' &&
                      selectedConnection.chatgptAccountId
                    ) {
                      const models =
                        (await window.lonelyChat!.listChatGPTModels?.(
                          selectedConnection.chatgptAccountId,
                        )) ?? [];
                      setChatGPTModels(models);
                      setDiscovered(models.map((entry) => entry.id));
                    } else
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
                  disabled={catalog.connections.some(
                    (entry) =>
                      entry.id === model.connectionId && entry.credentialMode === 'chatgpt',
                  )}
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
              {catalog.connections.some(
                (entry) => entry.id === model.connectionId && entry.credentialMode === 'chatgpt',
              ) && (
                <p className="text-xs text-zinc-400">
                  ChatGPT plan inference uses prompt-guided JSON and validates all output locally.
                  Unsupported sampling and structured-output parameters are omitted.
                </p>
              )}
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
