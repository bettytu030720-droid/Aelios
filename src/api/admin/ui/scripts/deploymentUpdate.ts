export const ADMIN_SCRIPT_DEPLOYMENT_UPDATE = `    deploymentUpdate: { state: 'off' },
    deploymentUpdateHost: '',
    deploymentUpdateTimer: null,
    deploymentUpdateRevision: 0,
    deploymentUpdateLoading: false,
    deploymentUpdateDeadline: 0,
    deploymentUpdateBusy() {
      return ['starting', 'deploying'].includes(this.deploymentUpdate.state);
    },
    deploymentUpdateVisible() {
      return Boolean(this.savedApiKey.trim()) && this.deploymentUpdateHost === this.base() &&
        (this.deploymentUpdateBusy() || ['available', 'failed'].includes(this.deploymentUpdate.state));
    },
    deploymentUpdateLabel() {
      if (this.deploymentUpdateBusy()) return this.L('更新中', 'Updating');
      return this.deploymentUpdate.state === 'failed' ? this.L('重试更新', 'Retry update') : this.L('更新', 'Update');
    },
    deploymentUpdateHint() {
      const reason = this.deploymentUpdate.reason;
      if (reason === 'merge_conflict') return this.L('Fork 有合并冲突，请在 GitHub 处理后重试。', 'Resolve the fork conflict on GitHub, then retry.');
      if (reason === 'fork_required') return this.L('请配置连接到 Workers Builds 的 Aelios fork。', 'Configure the Aelios fork connected to Workers Builds.');
      if (reason === 'github_permission') return this.L('请检查更新专用 GitHub Token 的权限。', 'Check the update token’s GitHub permissions.');
      if (reason === 'deploy_hook_required' || reason === 'deploy_hook_failed') return this.L('请检查生产分支的 Cloudflare Deploy Hook。', 'Check the Cloudflare Deploy Hook for the production branch.');
      if (reason === 'build_failed') return this.L('Cloudflare 构建失败，可以查看日志或重试。', 'The Cloudflare build failed. View its logs or retry.');
      if (reason === 'build_timeout') return this.L('暂未确认新版本上线，请查看 Cloudflare 构建记录。', 'The new deployment hasn’t been confirmed. Check Cloudflare build history.');
      if (this.deploymentUpdate.state === 'failed') return this.L('更新未完成，请重试。', 'The update didn’t finish. Try again.');
      if (this.deploymentUpdate.state === 'starting') return this.L('正在同步部署分支', 'Syncing the deployment branch');
      if (this.deploymentUpdate.state === 'deploying') return this.L('等待 Cloudflare 构建和发布', 'Waiting for Cloudflare to build and deploy');
      return this.L('同步新提交并更新 Worker', 'Sync the latest commits and update the Worker');
    },
    resetDeploymentUpdate() {
      if (this.deploymentUpdateTimer !== null) window.clearTimeout(this.deploymentUpdateTimer);
      this.deploymentUpdateTimer = null;
      this.deploymentUpdateRevision += 1;
      this.deploymentUpdate = { state: 'off' };
      this.deploymentUpdateDeadline = 0;
      this.deploymentUpdateLoading = false;
    },
    async loadDeploymentUpdate(start = false) {
      const host = this.base();
      const key = this.savedApiKey;
      if (!key.trim() || this.deploymentUpdateHost !== host) this.resetDeploymentUpdate();
      this.deploymentUpdateHost = host;
      if (!key.trim() || (this.deploymentUpdateLoading && !start)) return;
      const before = this.deploymentUpdate;
      if (start && !['available', 'failed'].includes(before.state)) return;
      if (this.deploymentUpdateTimer !== null) window.clearTimeout(this.deploymentUpdateTimer);
      this.deploymentUpdateTimer = null;
      const revision = ++this.deploymentUpdateRevision;
      const sameConnection = () => this.deploymentUpdateRevision === revision && this.base() === host && this.savedApiKey === key;
      const wasBusy = this.deploymentUpdateBusy();
      if (start) this.deploymentUpdate = { state: 'starting' };
      this.deploymentUpdateLoading = true;
      try {
        const opts = { method: start ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' };
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(start ? 55_000 : 15_000);
        const result = await this.request('/api/admin/update', opts);
        if (!sameConnection()) return;
        if (result.state !== 'unavailable' || !wasBusy) this.deploymentUpdate = result;
        if (wasBusy && result.state === 'current') {
          this.notify(this.L('Worker 已上线最新提交', 'The Worker is up to date'));
        }
        if ((wasBusy || start) && result.state === 'failed') this.notify(this.deploymentUpdateHint());
      } catch (error) {
        // The POST may have reached the Worker. Resume by reading the persisted attempt.
        if (sameConnection() && !start && !wasBusy) this.deploymentUpdate = { state: 'off' };
      } finally {
        if (this.deploymentUpdateRevision === revision) this.deploymentUpdateLoading = false;
      }
      if (!sameConnection()) return;
      if (this.deploymentUpdateBusy()) {
        if (!this.deploymentUpdateDeadline) this.deploymentUpdateDeadline = Date.now() + 26 * 60_000;
        if (Date.now() < this.deploymentUpdateDeadline) {
          this.deploymentUpdateTimer = window.setTimeout(() => this.loadDeploymentUpdate(), 8_000);
        } else {
          this.deploymentUpdate = { state: 'failed', reason: 'build_timeout' };
          this.deploymentUpdateDeadline = 0;
        }
      } else {
        this.deploymentUpdateDeadline = 0;
      }
    },
`;
