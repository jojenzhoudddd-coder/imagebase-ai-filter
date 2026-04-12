import { Field, CellValue, FieldType } from "../types.js";

interface ValidationResult {
  valid: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s\-+().]{3,30}$/;

export function validateCellValue(field: Field, value: CellValue): ValidationResult {
  // Null/undefined always valid (field is optional)
  if (value === null || value === undefined) return { valid: true };

  switch (field.type) {
    case "Text":
    case "Location":
    case "Barcode":
      if (typeof value !== "string") return { valid: false, error: `${field.name} 必须是文本` };
      return { valid: true };

    case "Number": {
      if (typeof value !== "number" || isNaN(value)) return { valid: false, error: `${field.name} 必须是数字` };
      return { valid: true };
    }

    case "Checkbox":
      if (typeof value !== "boolean") return { valid: false, error: `${field.name} 必须是布尔值` };
      return { valid: true };

    case "SingleSelect":
    case "ai_classify": {
      if (typeof value !== "string") return { valid: false, error: `${field.name} 必须是字符串` };
      if (field.config.options && !field.config.options.some(o => o.name === value || o.id === value)) {
        return { valid: false, error: `${field.name} 选项 "${value}" 不存在` };
      }
      return { valid: true };
    }

    case "MultiSelect":
    case "ai_tag": {
      if (!Array.isArray(value)) return { valid: false, error: `${field.name} 必须是数组` };
      if (field.config.options) {
        for (const v of value) {
          if (!field.config.options.some(o => o.name === String(v) || o.id === String(v))) {
            return { valid: false, error: `${field.name} 选项 "${v}" 不存在` };
          }
        }
      }
      return { valid: true };
    }

    case "User":
    case "CreatedUser":
    case "ModifiedUser": {
      if (typeof value === "string") return { valid: true }; // single user ID
      if (Array.isArray(value)) {
        if (!field.config.allowMultipleUsers && value.length > 1) {
          return { valid: false, error: `${field.name} 不允许多个成员` };
        }
        return { valid: true };
      }
      return { valid: false, error: `${field.name} 必须是用户ID或用户ID数组` };
    }

    case "Group": {
      if (typeof value === "string") return { valid: true };
      if (Array.isArray(value)) {
        if (!field.config.allowMultipleGroups && value.length > 1) {
          return { valid: false, error: `${field.name} 不允许多个群组` };
        }
        return { valid: true };
      }
      return { valid: false, error: `${field.name} 必须是群组ID或群组ID数组` };
    }

    case "DateTime": {
      if (typeof value !== "number" && typeof value !== "string") {
        return { valid: false, error: `${field.name} 必须是时间戳或日期字符串` };
      }
      return { valid: true };
    }

    case "Email":
      if (typeof value !== "string" || !EMAIL_RE.test(value)) {
        return { valid: false, error: `${field.name} 邮箱格式不正确` };
      }
      return { valid: true };

    case "Phone":
      if (typeof value !== "string" || !PHONE_RE.test(value)) {
        return { valid: false, error: `${field.name} 电话格式不正确` };
      }
      return { valid: true };

    case "Url":
      if (typeof value !== "string") return { valid: false, error: `${field.name} 必须是字符串` };
      return { valid: true };

    case "Progress": {
      if (typeof value !== "number") return { valid: false, error: `${field.name} 必须是数字` };
      if (value < 0 || value > 100) return { valid: false, error: `${field.name} 进度值必须在 0-100 之间` };
      return { valid: true };
    }

    case "Currency": {
      if (typeof value !== "number") return { valid: false, error: `${field.name} 必须是数字` };
      return { valid: true };
    }

    case "Rating": {
      if (typeof value !== "number") return { valid: false, error: `${field.name} 必须是数字` };
      const min = field.config.ratingMin ?? 0;
      const max = field.config.ratingMax ?? 5;
      if (value < min || value > max) return { valid: false, error: `${field.name} 评分值必须在 ${min}-${max} 之间` };
      return { valid: true };
    }

    case "SingleLink":
    case "DuplexLink": {
      if (typeof value === "string") return { valid: true };
      if (Array.isArray(value)) {
        if (!field.config.linkAllowMultiple && value.length > 1) {
          return { valid: false, error: `${field.name} 仅允许关联单条记录` };
        }
        return { valid: true };
      }
      return { valid: false, error: `${field.name} 必须是记录ID或记录ID数组` };
    }

    // Read-only fields
    case "AutoNumber":
    case "CreatedTime":
    case "ModifiedTime":
    case "Formula":
    case "Lookup":
      return { valid: false, error: `${field.name} 是自动生成的字段，不可编辑` };

    case "Attachment":
      if (typeof value !== "string" && !Array.isArray(value)) {
        return { valid: false, error: `${field.name} 必须是文件URL或URL数组` };
      }
      return { valid: true };

    // AI fields are auto-generated, but allow manual override
    case "ai_summary":
    case "ai_transition":
    case "ai_extract":
    case "ai_custom":
      return { valid: true };

    default:
      return { valid: true };
  }
}

export function validateFieldConfig(type: FieldType, config: Record<string, unknown>): ValidationResult {
  // Validate view name constraints
  if (type === "SingleSelect" || type === "MultiSelect") {
    if (config.refOptionFieldId && config.refOptionFieldId === config.selfId) {
      return { valid: false, error: "选项列表不可引用自身" };
    }
  }

  if (type === "Rating") {
    const max = (config.ratingMax as number) ?? 5;
    if (max < 1 || max > 10) return { valid: false, error: "评分终点必须在 1-10 之间" };
  }

  if (type === "Progress") {
    const precision = config.progressPrecision as number;
    if (precision !== undefined && ![0, 1, 2].includes(precision)) {
      return { valid: false, error: "进度精度仅支持 0/1/2 位小数" };
    }
  }

  return { valid: true };
}
