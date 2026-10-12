'use client';

import {
  HddOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  TagsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Drawer, Grid, Layout, Menu, Tag, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { useAdminAuth } from '@/features/auth/admin-auth-provider';

interface NavigationLeaf {
  href: string;
  label: string;
  icon: ReactNode;
  permission: string;
}

interface NavigationGroup {
  key: string;
  label: string;
  icon: ReactNode;
  children: readonly NavigationLeaf[];
}

const navigationGroups: readonly NavigationGroup[] = [
  {
    key: 'beta-access',
    label: '内测准入',
    icon: <TagsOutlined />,
    children: [
      { href: '/invites', label: '邀请码', icon: <TagsOutlined />, permission: 'invites.read' },
    ],
  },
  {
    key: 'ai-capabilities',
    label: 'AI 能力',
    icon: <RobotOutlined />,
    children: [
      { href: '/models', label: '模型配置', icon: <RobotOutlined />, permission: 'models.read' },
      { href: '/storage', label: '对象存储', icon: <HddOutlined />, permission: 'storage.read' },
    ],
  },
] as const;

const navigationLeaves: readonly NavigationLeaf[] = navigationGroups.flatMap(
  (group) => group.children,
);

function activeKey(pathname: string): string {
  return (
    navigationLeaves.find((item) =>
      item.href === '/' ? pathname === '/' : pathname.startsWith(item.href),
    )?.href ?? '/invites'
  );
}

function activeGroupKey(pathname: string): string | undefined {
  return navigationGroups.find((group) =>
    group.children.some((item) => pathname.startsWith(item.href)),
  )?.key;
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={`flex h-16 shrink-0 items-center border-b border-white/10 ${collapsed ? 'justify-center px-2' : 'gap-3 px-5'}`}
    >
      <span className="grid size-8 place-items-center rounded-md bg-white text-[var(--navigation)]">
        <SafetyCertificateOutlined aria-hidden />
      </span>
      {!collapsed ? (
        <div>
          <div className="text-sm font-bold text-white">Ecom Forge</div>
          <div className="text-[11px] text-[var(--navigation-muted)]">Control Plane</div>
        </div>
      ) : null}
    </div>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const screens = Grid.useBreakpoint();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const auth = useAdminAuth();
  if (auth.status !== 'authenticated') return null;

  const permissions = new Set(auth.session.permissions);
  const currentNavigation = navigationLeaves.find((item) => item.href === activeKey(pathname));
  const stepUpActive =
    auth.session.step_up_expires_at !== null &&
    new Date(auth.session.step_up_expires_at).getTime() > Date.now();
  const groupedItems = navigationGroups.flatMap((group) => {
    const children = group.children
      .filter((item) => permissions.has(item.permission))
      .map((item) => ({
        icon: item.icon,
        key: item.href,
        label: (
          <Link href={item.href} onClick={() => setMobileOpen(false)}>
            {item.label}
          </Link>
        ),
      }));
    return children.length > 0
      ? [{ children, icon: group.icon, key: group.key, label: group.label }]
      : [];
  });
  const menuItems = groupedItems;

  async function logout() {
    setLoggingOut(true);
    await auth.logout().catch(() => undefined);
  }

  const navigationMenu = (inlineCollapsed = false) => (
    <Menu
      className="border-e-0!"
      defaultOpenKeys={[activeGroupKey(pathname)].filter((key): key is string => Boolean(key))}
      inlineCollapsed={inlineCollapsed}
      items={menuItems}
      mode="inline"
      selectedKeys={[activeKey(pathname)]}
      theme="dark"
    />
  );

  return (
    <Layout className="min-h-screen!">
      <Layout.Sider
        className="fixed! inset-y-0 left-0 z-40 hidden h-screen! lg:flex! lg:flex-col"
        collapsed={collapsed}
        collapsedWidth={72}
        theme="dark"
        trigger={null}
        width={232}
      >
        <Brand collapsed={collapsed} />
        <nav
          aria-label="管理台主导航"
          className="admin-navigation-scroll min-h-0 flex-1 overflow-y-auto py-3"
        >
          {navigationMenu(collapsed)}
        </nav>
      </Layout.Sider>

      <Drawer
        closeIcon={false}
        onClose={() => setMobileOpen(false)}
        open={mobileOpen}
        placement="left"
        styles={{
          body: { background: '#202522', overflowY: 'auto', padding: 0 },
          header: {
            background: '#202522',
            borderBottomColor: 'rgb(255 255 255 / 10%)',
            padding: 0,
          },
        }}
        title={<Brand />}
        width={280}
      >
        <nav aria-label="移动端管理台主导航" className="py-3">
          {navigationMenu()}
        </nav>
      </Drawer>

      <Layout
        className={`min-w-0 transition-[margin] duration-200 ${collapsed ? 'lg:ml-[72px]' : 'lg:ml-[232px]'}`}
      >
        <Layout.Header className="sticky! top-0 z-30 flex! h-16! items-center justify-between border-b border-[var(--border)] bg-white! px-4! sm:px-6!">
          <div className="flex items-center gap-3">
            {screens.lg === false ? (
              <Tooltip title="打开导航">
                <Button
                  aria-label="打开导航"
                  icon={<MenuOutlined />}
                  onClick={() => setMobileOpen(true)}
                  type="text"
                />
              </Tooltip>
            ) : null}
            {screens.lg ? (
              <Tooltip title={collapsed ? '展开导航' : '收起导航'}>
                <Button
                  aria-label={collapsed ? '展开导航' : '收起导航'}
                  icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={() => setCollapsed((value) => !value)}
                  type="text"
                />
              </Tooltip>
            ) : null}
            <Typography.Text className="hidden font-semibold! sm:inline">
              {currentNavigation?.label ?? '管理控制面'}
            </Typography.Text>
          </div>
          <div className="flex items-center gap-3">
            <Tag className="hidden! md:inline-flex!" color={stepUpActive ? 'success' : 'default'}>
              {stepUpActive ? '敏感操作已验证' : '敏感操作需验证'}
            </Tag>
            <Avatar icon={<UserOutlined />} />
            <div className="hidden text-right sm:block">
              <div className="text-sm font-semibold">{auth.session.principal.displayName}</div>
              <Typography.Text className="!text-xs" type="secondary">
                {auth.session.principal.identifierHint}
              </Typography.Text>
            </div>
            <Button
              aria-label="退出管理台"
              icon={<LogoutOutlined />}
              loading={loggingOut}
              onClick={() => {
                void logout();
              }}
              type="text"
            >
              <span className="hidden sm:inline">退出</span>
            </Button>
          </div>
        </Layout.Header>
        <Layout.Content id="main-content">{children}</Layout.Content>
      </Layout>
    </Layout>
  );
}
