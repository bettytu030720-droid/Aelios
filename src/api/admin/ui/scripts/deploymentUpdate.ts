export const ADMIN_SCRIPT_DEPLOYMENT_UPDATE = `    deploymentUpdate: { state: 'off' },
    deploymentUpdateHost: '',
    deploymentUpdateTimer: null,
    deploymentUpdateRevision: 0,
    deploymentUpdateLoading: false,
    deploymentUpdateDeadline: 0,
    deploymentUpdateBusy() {
      return ['starting', 'deploying', 'connecting'].includes(this.deploymentUpdate.state);
    },
    deploymentUpdateVisible() {
      return Boolean(this.savedApiKey.trim()) && this.deploymentUpdateHost === this.base() &&
        (this.deploymentUpdateBusy() || ['available', 'failed', 'connect'].includes(this.deploymentUpdate.state));
    },
    deploymentUpdateLabel() {
      if (this.deploymentUpdate.state === 'connect') return this.L('连接 GitHub', 'Connect GitHub');
      if (this.deploymentUpdate.state === 'connecting') return this.L('连接中', 'Connecting');
      if (this.deploymentUpdate.reason === 'awaiting_live_commit') return this.L('发布中', 'Deploying');
      if (this.deploymentUpdateBusy()) return this.L('更新中', 'Updating');
      return this.deploymentUpdate.state === 'failed' ? this.L('重试', 'Retry') : this.L('更新', 'Update');
    },
    deploymentUpdateHint() {
      const reason = this.deploymentUpdate.reason;
      if (['connect', 'connecting'].includes(this.deploymentUpdate.state)) {
        const repo = this.deploymentUpdate.repo;
        return this.L('在 GitHub 将更新 App 安装到 ' + repo + '，以后直接在这里更新。',
          'Install the update app on ' + repo + ' to update from here.');
      }
      if (reason === 'merge_conflict') return this.L('Fork 有合并冲突，请在 GitHub 处理后重试。', 'Resolve the fork conflict on GitHub, then retry.');
      if (reason === 'fork_required') return this.L('请配置连接到 Workers Builds 的 Aelios fork。', 'Configure the Aelios fork connected to Workers Builds.');
      if (reason === 'github_permission') return this.L('请检查 GitHub 的更新权限。', 'Check GitHub’s update permissions.');
      if (reason === 'sync_rejected') return this.L('GitHub 拒绝了同步。请检查 Fork 分支和令牌权限。', 'GitHub rejected the sync. Check the fork branch and token permissions.');
      if (reason === 'deploy_hook_required' || reason === 'deploy_hook_failed') return this.L('请检查生产分支的 Cloudflare Deploy Hook。', 'Check the Cloudflare Deploy Hook for the production branch.');
      if (reason === 'build_failed') return this.L('Cloudflare 构建失败，可以查看日志或重试。', 'The Cloudflare build failed. View its logs or retry.');
      if (reason === 'build_timeout') return this.L('暂未确认新版本上线，请查看 Cloudflare 构建记录。', 'The new deployment hasn’t been confirmed. Check Cloudflare build history.');
      if (reason === 'awaiting_live_commit') return this.L('Cloudflare 构建已通过，等待 Worker 报出新提交。', 'Cloudflare built successfully. Waiting for the Worker to serve the new commit.');
      if (this.deploymentUpdate.state === 'failed') return this.L('更新未完成，请重试。', 'The update didn’t finish. Try again.');
      if (this.deploymentUpdate.state === 'starting') return this.L('正在同步部署分支', 'Syncing the deployment branch');
      if (this.deploymentUpdate.state === 'deploying') return this.L('等待 Cloudflare 构建和发布', 'Waiting for Cloudflare to build and deploy');
      return this.L('同步新提交并更新 Worker', 'Sync the latest commits and update the Worker');
    },
    deploymentGitHubResult() {
      if (!location.search) return;
      const url = new URL(location.href);
      const result = url.searchParams.get('update-github');
      if (!result) return;
      url.searchParams.delete('update-github');
      history.replaceState(null, '', url.href);
      if (result === 'connected') this.notify(this.L('GitHub 已连接，可以更新了。', 'GitHub connected. Ready to update.'));
      if (result === 'install') this.notify(this.L('请在 GitHub 将 App 安装到当前 Worker 的 Fork。', 'Install the app on this Worker’s fork.'));
      if (result === 'error') this.notify(this.L('GitHub 连接未完成，请重试。', 'GitHub connection didn’t finish. Try again.'));
    },
    async startDeploymentUpdate() {
      const before = this.deploymentUpdate;
      if (before.state !== 'connect') return this.loadDeploymentUpdate(true);
      const host = this.base();
      const key = this.savedApiKey;
      if (host !== location.origin) {
        this.notify(this.L('请直接打开这个 Worker 的后台，再连接 GitHub。', 'Open this Worker’s admin to connect GitHub.'));
        return;
      }
      const revision = ++this.deploymentUpdateRevision;
      const sameConnection = () => this.deploymentUpdateRevision === revision && this.base() === host && this.savedApiKey === key;
      this.deploymentUpdateLoading = false;
      this.deploymentUpdate = { ...before, state: 'connecting' };
      try {
        const result = await this.request('/api/admin/update/connect', { method: 'POST', headers: { Authorization: 'Bearer ' + key } });
        if (!sameConnection()) return;
        if (result.connected) {
          this.deploymentUpdate = before;
          this.notify(this.L('GitHub 已连接，可以更新了。', 'GitHub connected. Ready to update.'));
          await this.loadDeploymentUpdate();
          return;
        }
        const target = new URL(result.url);
        if (target.origin !== 'https://github.com' || target.username || target.password) throw new Error('Invalid GitHub URL');
        if (!result.manifest) {
          location.assign(target.href);
          return;
        }
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = target.href;
        form.rel = 'noreferrer';
        form.hidden = true;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'manifest';
        input.value = result.manifest;
        form.append(input);
        document.body.append(form);
        form.submit();
      } catch {
        if (sameConnection()) {
          this.notify(this.L('GitHub 连接未完成，请重试。', 'GitHub connection didn’t finish. Try again.'));
        }
      } finally {
        if (sameConnection() && this.deploymentUpdate.state === 'connecting') this.deploymentUpdate = before;
      }
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
      if (!key.trim() || this.deploymentUpdate.state === 'connecting' || (this.deploymentUpdateLoading && !start)) return;
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
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(start ? 75_000 : 30_000);
        const result = await this.request('/api/admin/update', opts);
        if (!sameConnection()) return;
        if (result.state !== 'unavailable' || !wasBusy) this.deploymentUpdate = result;
        if (wasBusy && result.state === 'current') {
          this.notify(this.L('Worker 已上线最新提交', 'The Worker is up to date'));
        }
        if (wasBusy && result.state === 'off') {
          this.notify(this.L('暂时无法确认线上版本，请查看 Cloudflare 构建记录。', 'The live version could not be confirmed. Check Cloudflare build history.'));
        }
        if ((wasBusy || start) && ['failed', 'connect'].includes(result.state)) this.notify(this.deploymentUpdateHint());
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
