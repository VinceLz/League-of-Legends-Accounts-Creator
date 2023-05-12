import Express from 'express';
import Promise from 'bluebird';
import bodyParser from 'body-parser';
import generateData from '../dataGeneration.js';
import checkProxy from './checkProxy.js';
import getCaptchaBalance from './captchas/getBalance.js';
import registration from './registration.js';
import { isDev, STATUS } from '../../constants/constants.js';
import { sleep } from '../../utils/utils.js';
import save from '../save.js';

const crlf = (text) => text.replace(/\r\n|\r(?!\n)|\n/g, '\n');

export default () => {
  const app = new Express();
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(
    bodyParser.urlencoded({
      limit: '50mb',
      extended: true,
      parameterLimit: 50000,
    })
  );

  const proxyData = { isChecking: false, list: [], checked: [] };
  const accountsState = { isGenerating: false, isStopped: false, list: [] };
  const generatedAccounts = { list: [] };
  const currentState = { state: {} };

  app.post('/generate', (req, res) => {
    const { state } = req.body;
    generatedAccounts.list = [];
    currentState.state = state;
    generatedAccounts.list = generateData(state);
    res.json(generatedAccounts.list);
  });

  app.delete('/clear', (req, res) => {
    proxyData.checked = [];
    res.json(proxyData);
  });

  app.post('/updateproxylist', async (req, res) => {
    const { list } = req.body;
    const normalized = crlf(list).trim().split('\n');
    proxyData.list = normalized;
    res.json(proxyData);
  });

  app.post('/proxycheck', async (req, res) => {
    const list = req.body;
    proxyData.isChecking = true;
    proxyData.checked = [];
    res.json(proxyData);
    await Promise.map(
      list,
      async (item) => {
        const result = await Promise.race([
          checkProxy(item),
          sleep(30000).then(() => ({ ...item, isWorking: STATUS.PROXY.NOT_WORKING })),
        ]);
        proxyData.checked.push(result);
      },
      { concurrency: 100 }
    );
    proxyData.isChecking = false;
  });

  app.get('/ischecking', (_req, res) => {
    res.json(proxyData);
  });

  app.get('/test', (_req, res) => {
    res.send(global.errors);
  });

  global.RATE_LIMITED_PROXIES = new Set();
  global.USED_USERNAMES = new Set();
  app.post('/stop_creation', (req, res) => {
    accountsState.isStopped = true;
    res.json({ stopped: true });
  });

  app.post('/signup', async (req, res) => {
    accountsState.isStopped = false;
    const state = req.body;
    const accountsInProgress = generatedAccounts.list.map((acc) => ({ ...acc, status: STATUS.ACCOUNT.IN_PROGRESS }));
    res.json({ isGenerating: true, list: accountsInProgress });

    accountsState.isGenerating = true;
    accountsState.list = [];

    const captcha = {
      type: state.currentCaptcha,
      apiKey: state.apiKey,
    };

    let captchaError;
    const balance = await getCaptchaBalance({ ...captcha, currentCaptcha: captcha.type });
    if (balance === 'TRY AGAIN PLEASE') {
      captchaError = 'CHECK_YOUR_CAPTCHA_COFNIG';
    }
    if (`${balance}`.includes('_')) {
      captchaError = balance;
    }
    if (Number(balance) <= 0) {
      captchaError = 'CAPTCHA_ZERO_BALANCE';
    }
    const proxyList = state.useProxy
      ? proxyData.checked.filter(({ isWorking }) => isWorking === STATUS.PROXY.WORKING)
      : [];

    await Promise.map(
      accountsInProgress,
      async (account) => {
        if (accountsState.isStopped) {
          accountsState.list.push({
            ...account,
            status: STATUS.ACCOUNT.FAILED,
            errors: 'CREATION_WAS_STOPPED',
          });
          return;
        }
        if (captchaError) {
          accountsState.list.push({
            ...account,
            status: STATUS.ACCOUNT.FAILED,
            errors: captchaError,
          });
          return;
        }
        const result = await Promise.race([
          registration(account, captcha, proxyList),
          sleep(600 * 1000).then(() => ({
            ...account,
            status: STATUS.ACCOUNT.FAILED,
            errors: 'GENERAL_TIMEOUT',
          })),
        ]);
        accountsState.list.push(result);
      },
      { concurrency: 50 }
    );

    accountsState.isStopped = false;
    accountsState.isGenerating = false;
    if (!isDev) save(accountsState.list, state, global.USED_USERNAMES);
  });

  app.get('/signup', (_req, res) => {
    res.json({
      ...accountsState,
      rateLimitedProxies: global.RATE_LIMITED_PROXIES.size,
      isCreationStopped: accountsState.isStopped,
    });
  });

  app.post('/getbalance', async (req, res) => {
    const config = req.body;
    const balance = await getCaptchaBalance(config);
    res.json({ balance });
  });

  app.get('/serverstate', (_req, res) => {
    res.json({ proxyData, accountsState, generatedAccounts, currentState });
  });

  return app;
};
