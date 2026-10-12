'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { AgentPendingConfirmation, ProductFacts } from '@/lib/agent-api';

type ProductFactsConfirmation = Extract<AgentPendingConfirmation, { type: 'product_facts' }>;

export function ProductFactsCard({
  confirmation,
  disabled,
  onConfirm,
}: {
  confirmation: ProductFactsConfirmation;
  disabled: boolean;
  onConfirm: (answers: Record<string, unknown>) => Promise<void>;
}) {
  const candidate = confirmation.public_payload.candidate_facts;
  const [productName, setProductName] = useState(candidate.product_name);
  const [skuCode, setSkuCode] = useState('');
  const [primaryColors, setPrimaryColors] = useState(joinList(candidate.primary_colors));
  const [logos, setLogos] = useState(joinList(candidate.logos));
  const [visibleText, setVisibleText] = useState(joinList(candidate.visible_text));
  const [materials, setMaterials] = useState(joinList(candidate.materials));
  const [mustPreserve, setMustPreserve] = useState(joinList(candidate.must_preserve));
  const [unknownFields, setUnknownFields] = useState(joinList(candidate.unknown_fields));
  const [confirmedNoVisibleText, setConfirmedNoVisibleText] = useState(false);
  const hasVisibleTextDecision = splitList(visibleText).length > 0 || confirmedNoVisibleText;
  const canSubmit = productName.trim().length > 0 && hasVisibleTextDecision;

  const submit = () => {
    const facts: ProductFacts = {
      product_name: productName.trim(),
      primary_colors: splitList(primaryColors),
      logos: splitList(logos),
      visible_text: confirmedNoVisibleText ? [] : splitList(visibleText),
      materials: splitList(materials),
      must_preserve: splitList(mustPreserve),
      unknown_fields: splitList(unknownFields),
    };
    void onConfirm({
      ...(confirmation.public_payload.mode === 'create_product' && skuCode.trim()
        ? { sku_code: skuCode.trim() }
        : {}),
      facts,
    });
  };

  return (
    <section className="ml-0 mt-6 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] sm:ml-11">
      <div className="border-b border-[var(--border)] px-4 py-4">
        <h2 className="text-sm font-semibold">确认商品事实</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
          这些信息会用于保持商品外观和包装文字一致。
        </p>
      </div>
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        <FactInput
          disabled={disabled}
          label="商品名称"
          onChange={setProductName}
          required
          value={productName}
        />
        {confirmation.public_payload.mode === 'create_product' ? (
          <FactInput
            disabled={disabled}
            label="SKU / 货号（选填）"
            onChange={setSkuCode}
            value={skuCode}
          />
        ) : null}
        <FactInput
          disabled={disabled}
          hint="多个内容用逗号分隔"
          label="主色 / 关键颜色"
          onChange={setPrimaryColors}
          value={primaryColors}
        />
        <FactInput
          disabled={disabled}
          hint="多个内容用逗号分隔"
          label="Logo / 包装标识"
          onChange={setLogos}
          value={logos}
        />
        <div className="sm:col-span-2">
          <FactInput
            disabled={disabled || confirmedNoVisibleText}
            hint="逐字核对，多个内容用逗号分隔"
            label="可见文字"
            onChange={(value) => {
              setVisibleText(value);
              if (value.trim()) setConfirmedNoVisibleText(false);
            }}
            required
            value={visibleText}
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={confirmedNoVisibleText}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setConfirmedNoVisibleText(next);
                if (next) setVisibleText('');
              }}
            />
            当前图片没有可见文字
          </label>
        </div>
        <FactInput
          disabled={disabled}
          hint="不确定可留空"
          label="材质"
          onChange={setMaterials}
          value={materials}
        />
        <FactInput
          disabled={disabled}
          hint="例如主体结构、配件数量"
          label="必须保留"
          onChange={setMustPreserve}
          value={mustPreserve}
        />
        <div className="sm:col-span-2">
          <FactInput
            disabled={disabled}
            hint="尚无法确认的项目，多个内容用逗号分隔"
            label="仍不确定"
            onChange={setUnknownFields}
            value={unknownFields}
          />
        </div>
      </div>
      <div className="flex items-center justify-end border-t border-[var(--border)] px-4 py-3">
        <Button disabled={disabled || !canSubmit} onClick={submit} size="sm">
          {disabled ? '提交中…' : '确认商品事实并继续'}
        </Button>
      </div>
    </section>
  );
}

function FactInput({
  disabled,
  hint,
  label,
  onChange,
  required = false,
  value,
}: {
  disabled: boolean;
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  value: string;
}) {
  return (
    <label className="block text-sm font-medium">
      <span>
        {label}
        {required ? <span className="ml-1 text-[var(--danger)]">*</span> : null}
      </span>
      {hint ? (
        <span className="ml-2 text-xs font-normal text-[var(--muted-foreground)]">{hint}</span>
      ) : null}
      <Input
        aria-label={label}
        className="mt-1.5"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function joinList(values: string[]): string {
  return values.join('，');
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
