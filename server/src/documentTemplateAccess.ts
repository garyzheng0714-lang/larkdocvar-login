import type express from 'express';
import {
  canReadDocumentTemplate,
  resolveDefaultDocumentTemplateActor,
  type DocumentTemplateResolver,
} from './documentTemplateApi';
import { UserFacingError } from './documentRenderStorageErrors';

export function createRequestScopedDocumentTemplateResolver(
  request: express.Request,
  templateResolver: DocumentTemplateResolver | undefined,
): DocumentTemplateResolver | undefined {
  if (!templateResolver) return undefined;
  return {
    async loadTemplate(templateId, versionId) {
      const [actor, loaded] = await Promise.all([
        resolveDefaultDocumentTemplateActor(request),
        templateResolver.loadTemplate(templateId, versionId),
      ]);
      if (!canReadDocumentTemplate(loaded.record, actor)) {
        throw new UserFacingError('没有权限使用此模板。');
      }
      return loaded;
    },
  };
}
