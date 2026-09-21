import {
  type ApiClientConfig,
  httpRequest,
} from "@ttoltori/api-client-core";
import type {
  AnalyzeRequest,
  AnalyzeResult,
  BulkSubscription,
  Category,
  CreateSourceRequest,
  CreateSourceResponse,
  DeskPayload,
  DigestPreview,
  DigestRun,
  DigestSettings,
  Item,
  KeywordRule,
  Me,
  RequestMagicLink,
  RuleScopeType,
  SourceDetail,
  Subscription,
  Tag,
  UpdateSubscription,
  UpsertKeywordRule,
} from "@myportal/api-contracts";

export interface ItemScope {
  type: "all" | "special" | "category" | "tag" | "source";
  id: string | null;
}

export function createMyportalClient(config: ApiClientConfig) {
  return {
    auth: {
      requestMagicLink: (body: RequestMagicLink) =>
        httpRequest<{ sent: boolean; devLink?: string }>(
          config,
          "POST",
          "/v1/auth/magic-link",
          { body },
        ),
      logout: () => httpRequest<{ ok: true }>(config, "POST", "/v1/auth/logout"),
      me: () => httpRequest<Me>(config, "GET", "/v1/me"),
    },

    desk: {
      get: () => httpRequest<DeskPayload>(config, "GET", "/v1/desk"),
      heartbeat: () =>
        httpRequest<{ lastVisitAt: string | null }>(
          config,
          "POST",
          "/v1/desk/heartbeat",
        ),
    },

    items: {
      updateState: (
        itemId: string,
        body: { read?: boolean; starred?: boolean },
      ) =>
        httpRequest<{ items: Item[] }>(
          config,
          "PATCH",
          `/v1/items/${itemId}`,
          { body },
        ),
      markAllRead: (scope: ItemScope) =>
        httpRequest<{ updatedIds: string[] }>(
          config,
          "POST",
          "/v1/items/read-all",
          { body: { scope } },
        ),
      restoreStates: (itemIds: string[], read: boolean) =>
        httpRequest<{ updated: number }>(
          config,
          "POST",
          "/v1/items/state",
          { body: { itemIds, read } },
        ),
      search: (q: string) =>
        httpRequest<{ items: Item[] }>(config, "GET", "/v1/items/search", {
          query: { q },
        }),
    },

    categories: {
      list: () => httpRequest<Category[]>(config, "GET", "/v1/categories"),
      create: (body: { name: string; parentId: string | null }) =>
        httpRequest<Category>(config, "POST", "/v1/categories", { body }),
      update: (
        id: string,
        body: { name?: string; parentId?: string | null },
      ) =>
        httpRequest<Category>(config, "PATCH", `/v1/categories/${id}`, {
          body,
        }),
      remove: (id: string) =>
        httpRequest<{ ok: true }>(config, "DELETE", `/v1/categories/${id}`),
      merge: (id: string, targetId: string) =>
        httpRequest<{ ok: true }>(
          config,
          "POST",
          `/v1/categories/${id}/merge`,
          { body: { targetId } },
        ),
    },

    tags: {
      list: () => httpRequest<Tag[]>(config, "GET", "/v1/tags"),
      create: (body: { name: string }) =>
        httpRequest<Tag>(config, "POST", "/v1/tags", { body }),
      update: (id: string, body: { name: string }) =>
        httpRequest<Tag>(config, "PATCH", `/v1/tags/${id}`, { body }),
      remove: (id: string) =>
        httpRequest<{ ok: true }>(config, "DELETE", `/v1/tags/${id}`),
    },

    subscriptions: {
      list: () =>
        httpRequest<Subscription[]>(config, "GET", "/v1/subscriptions"),
      update: (id: string, body: UpdateSubscription) =>
        httpRequest<Subscription>(
          config,
          "PATCH",
          `/v1/subscriptions/${id}`,
          { body },
        ),
      remove: (id: string) =>
        httpRequest<{ ok: true }>(config, "DELETE", `/v1/subscriptions/${id}`),
      bulk: (body: BulkSubscription) =>
        httpRequest<{ updated: number }>(
          config,
          "POST",
          "/v1/subscriptions/bulk",
          { body },
        ),
    },

    sources: {
      analyze: (body: AnalyzeRequest) =>
        httpRequest<AnalyzeResult>(config, "POST", "/v1/sources/analyze", {
          body,
        }),
      create: (body: CreateSourceRequest) =>
        httpRequest<CreateSourceResponse>(config, "POST", "/v1/sources", {
          body,
        }),
      detail: (id: string) =>
        httpRequest<SourceDetail>(config, "GET", `/v1/sources/${id}`),
      collectNow: (id: string) =>
        httpRequest<{ newCount: number; runId: string }>(
          config,
          "POST",
          `/v1/sources/${id}/collect`,
        ),
      rebuildSpec: (id: string) =>
        httpRequest<{ version: number }>(
          config,
          "POST",
          `/v1/sources/${id}/rebuild-spec`,
        ),
    },

    keywordRules: {
      list: () => httpRequest<KeywordRule[]>(config, "GET", "/v1/keyword-rules"),
      create: (body: UpsertKeywordRule) =>
        httpRequest<KeywordRule>(config, "POST", "/v1/keyword-rules", { body }),
      update: (id: string, body: UpsertKeywordRule) =>
        httpRequest<KeywordRule>(config, "PATCH", `/v1/keyword-rules/${id}`, {
          body,
        }),
      remove: (id: string) =>
        httpRequest<{ ok: true }>(config, "DELETE", `/v1/keyword-rules/${id}`),
      preview: (body: {
        keywords: string[];
        exclude: string[];
        scope: RuleScopeType;
        scopeId: string | null;
      }) =>
        httpRequest<{ count: number; items: Item[] }>(
          config,
          "POST",
          "/v1/keyword-rules/preview",
          { body },
        ),
    },

    digest: {
      getSettings: () =>
        httpRequest<{
          settings: DigestSettings;
          history: DigestRun[];
          email: string;
        }>(config, "GET", "/v1/digest"),
      updateSettings: (body: DigestSettings) =>
        httpRequest<DigestSettings>(config, "PUT", "/v1/digest", { body }),
      preview: () =>
        httpRequest<DigestPreview>(config, "GET", "/v1/digest/preview"),
      sendNow: () =>
        httpRequest<{ sent: boolean; itemCount: number }>(
          config,
          "POST",
          "/v1/digest/send-now",
        ),
    },
  };
}

export type MyportalClient = ReturnType<typeof createMyportalClient>;
