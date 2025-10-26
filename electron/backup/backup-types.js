/**
 * 备份数据类型定义
 * 与安卓端的 BackupData.kt 保持一致，实现跨平台兼容
 */

/**
 * 备份类型枚举
 */
const BackupType = {
  CONFIG_ONLY: 'CONFIG_ONLY',    // 仅配置
  FULL_BACKUP: 'FULL_BACKUP'     // 全量备份
};

/**
 * 备份数据主结构（兼容安卓端）
 */
class BackupData {
  constructor() {
    this.version = '1.2'; // 与安卓端版本号一致
    this.timestamp = Date.now();
    this.backupType = BackupType.CONFIG_ONLY;
    this.activeProfile = null; // UUID string of active profile
    this.importedProfiles = []; // ImportedProfileBackup[]
    this.pendingProfiles = []; // PendingProfileBackup[]
    this.selections = []; // SelectionBackup[]
    this.proxyIconConfig = null; // ProxyIconConfigBackup
    // 全量备份字段
    this.serviceSettings = null; // ServiceSettingsBackup
    this.uiSettings = null; // UiSettingsBackup
    this.webDAVSettings = null; // WebDAVSettingsBackup
    this.appLockSettings = null; // AppLockSettingsBackup
    this.dashboardConfig = null; // DashboardConfigBackup
    this.trafficData = null; // TrafficDataBackup
    this.overrideSettings = null; // OverrideSettingsBackup
  }
}

/**
 * 导入的配置文件备份
 */
class ImportedProfileBackup {
  constructor() {
    this.uuid = ''; // UUID as string
    this.name = '';
    this.type = 'URL'; // "FILE", "URL", "EXTERNAL"
    this.source = '';
    this.interval = 0;
    this.upload = 0;
    this.download = 0;
    this.total = 0;
    this.expire = 0;
    this.iconUrl = '';
    this.createdAt = Date.now();
    this.configContent = null; // config.yaml content
    this.providersContent = {}; // providers files { filename: content }
  }
}

/**
 * 待处理的配置文件备份
 */
class PendingProfileBackup {
  constructor() {
    this.uuid = '';
    this.name = '';
    this.type = 'URL';
    this.source = '';
    this.interval = 0;
    this.upload = 0;
    this.download = 0;
    this.total = 0;
    this.expire = 0;
    this.iconUrl = '';
    this.createdAt = Date.now();
    this.configContent = null;
    this.providersContent = {};
  }
}

/**
 * 代理选择备份
 */
class SelectionBackup {
  constructor() {
    this.uuid = '';
    this.proxy = '';
    this.selected = '';
  }
}

/**
 * 代理图标配置备份
 */
class ProxyIconConfigBackup {
  constructor() {
    this.enabled = true;
    this.rules = []; // ProxyIconRuleBackup[]
    this.iconCacheFiles = {}; // { filename: base64Content }
  }
}

/**
 * 代理图标规则备份
 */
class ProxyIconRuleBackup {
  constructor() {
    this.id = '';
    this.name = '';
    this.regex = '';
    this.iconType = 'BASE64'; // "BASE64" or "URL"
    this.iconData = '';
    this.enabled = true;
    this.priority = 0;
  }
}

/**
 * 服务设置备份
 */
class ServiceSettingsBackup {
  constructor() {
    this.bypassPrivateNetwork = true;
    this.accessControlMode = 'AcceptAll';
    this.accessControlPackages = [];
    this.dnsHijacking = true;
    this.systemProxy = true;
    this.allowBypass = true;
    this.allowIpv6 = false;
    this.tunStackMode = 'system';
    this.dynamicNotification = true;
  }
}

/**
 * UI设置备份
 */
class UiSettingsBackup {
  constructor() {
    this.enableVpn = true;
    this.darkMode = 'Auto';
    this.hideAppIcon = false;
    this.proxyExcludeNotSelectable = false;
    this.proxyLine = 2;
    this.proxySort = 'Default';
    this.appLockEnabled = false;
    this.appLockPassword = '';
    this.appLockBiometricEnabled = false;
    this.appLockTimeout = 300000; // 5分钟
    this.userAgent = 'meta/0.1.9.3';
  }
}

/**
 * WebDAV设置备份
 */
class WebDAVSettingsBackup {
  constructor() {
    this.uri = '';
    this.username = '';
    this.password = '';
    this.backupDirectory = 'FlyClash';
    this.fileName = 'flyclash_backup.zip';
  }
}

/**
 * 应用锁设置备份
 */
class AppLockSettingsBackup {
  constructor() {
    this.enabled = false;
    this.passwordHash = '';
    this.biometricEnabled = false;
    this.timeout = 300000;
  }
}

/**
 * 仪表板配置备份
 */
class DashboardConfigBackup {
  constructor() {
    this.cardOrder = [];
    this.enabledCards = [];
    this.cardSettings = {};
  }
}

/**
 * 流量数据备份
 */
class TrafficDataBackup {
  constructor() {
    this.selectedProvider = null;
    this.selectedProfileUuid = null;
    this.providerName = null;
    this.upload = 0;
    this.download = 0;
    this.total = 0;
    this.expire = 0;
  }
}

/**
 * 覆盖设置备份
 */
class OverrideSettingsBackup {
  constructor() {
    this.jsOverrideEnabled = false;
    this.jsOverrideContent = '';
    this.yamlOverrideEnabled = false;
    this.yamlOverrideContent = '';
  }
}

module.exports = {
  BackupType,
  BackupData,
  ImportedProfileBackup,
  PendingProfileBackup,
  SelectionBackup,
  ProxyIconConfigBackup,
  ProxyIconRuleBackup,
  ServiceSettingsBackup,
  UiSettingsBackup,
  WebDAVSettingsBackup,
  AppLockSettingsBackup,
  DashboardConfigBackup,
  TrafficDataBackup,
  OverrideSettingsBackup
};
