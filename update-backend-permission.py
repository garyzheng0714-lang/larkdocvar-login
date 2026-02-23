import sys

with open('server/src/feishu.ts', 'r') as f:
    content = f.read()

# Update PermissionMode type
content = content.replace(
    "type PermissionMode = 'internet_readable' | 'tenant_readable' | 'closed';",
    "type PermissionMode = 'internet_readable' | 'internet_editable' | 'tenant_readable' | 'tenant_editable' | 'closed';"
)

# Update updateDocumentPermission method
old_permission_logic = """  private async updateDocumentPermission(documentId: string, permissionMode: PermissionMode): Promise<void> {
    let externalAccessEntity: 'open' | 'closed' = 'open';
    let linkShareEntity: 'anyone_readable' | 'tenant_readable' | 'closed' = 'anyone_readable';

    if (permissionMode === 'tenant_readable') {
      externalAccessEntity = 'closed';
      linkShareEntity = 'tenant_readable';
    }
    if (permissionMode === 'closed') {
      externalAccessEntity = 'closed';
      linkShareEntity = 'closed';
    }

    await this.request('PATCH', `/drive/v2/permissions/${documentId}/public`, {"""

new_permission_logic = """  private async updateDocumentPermission(documentId: string, permissionMode: PermissionMode): Promise<void> {
    let externalAccessEntity: 'open' | 'closed' = 'closed';
    let linkShareEntity: 'anyone_readable' | 'anyone_editable' | 'tenant_readable' | 'tenant_editable' | 'closed' = 'closed';

    switch (permissionMode) {
      case 'internet_readable':
        externalAccessEntity = 'open';
        linkShareEntity = 'anyone_readable';
        break;
      case 'internet_editable':
        externalAccessEntity = 'open';
        linkShareEntity = 'anyone_editable';
        break;
      case 'tenant_readable':
        externalAccessEntity = 'closed';
        linkShareEntity = 'tenant_readable';
        break;
      case 'tenant_editable':
        externalAccessEntity = 'closed';
        linkShareEntity = 'tenant_editable';
        break;
      case 'closed':
      default:
        externalAccessEntity = 'closed';
        linkShareEntity = 'closed';
        break;
    }

    await this.request('PATCH', `/drive/v2/permissions/${documentId}/public`, {"""

if old_permission_logic in content:
    content = content.replace(old_permission_logic, new_permission_logic)
    print("Successfully patched backend permission logic.")
else:
    print("Could not find old_permission_logic.")

with open('server/src/feishu.ts', 'w') as f:
    f.write(content)

