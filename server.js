/*
 * @Author: Huangjs
 * @Date: 2021-05-20 09:41:55
 * @LastEditors: Huangjs
 * @LastEditTime: 2021-05-20 11:45:02
 * @Description: ******
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const config = {
  webhookUrl: 'http://10.5.13.101:3000/webhook', // 填写在github或gitlab的webhook上的地址，这里用不到，就是该服务的地址
  projectUrl: 'http://10.5.13.101:3000/build', // 打包压缩后文件发送到代码部署的服务地址
  username: 'root', // 使用http方式clone代码需要的用户名称
  password: 'huangjs@123', // 使用http方式clone代码需要的密码
  useSSH: false, // 是否使用SSH方式clone代码
  distName: 'docs', // 打包时配置的输出目录（webpack中output字段）
  branch: 'master', // 使用git上哪个分支发布
  buildCMD: 'build', // npm build时的命令，在项目package.json中scripts中
  listenPort: 3000, // 服务的端口
  workspace: '/home/nginx/html', // 代码部署低绝对路径，比如nginx
};

const rootDirectory = __dirname;

const encodeUrl = (s) => global.encodeURIComponent(s);

const log = {
  info: (s) => console.log(s),
  success: (s) => global.console.log(`\x1B[32m${s}\x1B[39m`),
  error: (s) => global.console.log(`\x1B[31m${s}\x1B[39m`),
  warn: (s) => global.console.log(`\x1B[33m${s}\x1B[39m`),
};

// 解析流的读取，request和response实际也是流的示例
const resolveStream = (stream) =>
  new Promise((resolve, reject) => {
    const buffers = [];
    // 每读一块数据触发data事件，chunk是Buffer实例
    stream.on('data', (chunk) => buffers.push(chunk));
    // 读完数据，触发end事件，这里可以处理结束逻辑
    stream.on('end', () => resolve(Buffer.concat(buffers)));
    stream.on('error', (e) => reject(e));
  });
// 读取文件流
const readFileStream = (filePath) =>
  new Promise((resolve, reject) =>
    fs.promises
      // 检查文件是否可读
      .access(filePath, fs.constants.R_OK)
      .then(() =>
        // 解析文件流
        resolveStream(fs.createReadStream(filePath))
          .then((buffer) => resolve(buffer))
          .catch((e) => reject(e)),
      )
      .catch(() => reject(new Error(`Cannot read file:${filePath}`))),
  );
// 将数据流写到文件中
const writeFileStream = (fileData, filePath) =>
  new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    writeStream.on('open', () => {
      // 文件打开后分块写入数据到文件中
      const size = 128;
      const { length } = fileData;
      const number = Math.ceil(length / size);
      for (let i = 0; i < number; i += 1) {
        writeStream.write(fileData.slice(size * i, Math.min(size * (i + 1), length)));
      }
      writeStream.end();
    });
    writeStream.on('finish', () => resolve());
    writeStream.on('error', (e) => reject(e));
  });
// 发送http请求
const sendFileByHttp = (url, fileData) =>
  new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST', // 请求类型
        headers: {
          'Content-Type': 'application/octet-stream', // 数据格式为二进制数据流
          'Transfer-Encoding': 'chunked', // 传输方式为分片传输
          Connection: 'keep-alive', // 这个比较重要为保持链接。
        },
      },
      (response) =>
        // 处理请求之后的响应
        resolveStream(response)
          .then((buffer) => resolve(buffer.toString()))
          .catch((e) => reject(e)),
    );
    request.on('error', (e) => reject(e));
    // 发送数据流
    request.write(fileData);
    request.end();
  });
// 执行命令
const execProcess = (command, options = {}) =>
  new Promise((resolve, reject) => {
    const { getInput, ...rest } = options || {};
    const child = exec(command, rest);
    // 标准输出，终端每输出一串字符，之前会触发该事件，实际是由log输出到终端
    child.stdout.on('data', (out) => {
      const outStr = out.toString();
      log.info(outStr);
      // 下面的调用getInput方法可以自动输入系统要求输入的数据，不过git clone似乎不行。。。
      if (typeof getInput === 'function') {
        const input = getInput(outStr);
        if (input) {
          // 标准输入，主动输入信息
          child.stdin.write(`${input}\n`);
          log.info(input);
        }
      }
    });
    // 标准错误输出
    child.stderr.on('data', (err) => {
      log.error(err.toString());
    });
    child.on('close', (code) => {
      child.stdin.end();
      if (code === 0) {
        // 正常退出
        resolve();
      } else {
        log.error(`exit ${code}`);
        reject(new Error('The command is exit!'));
      }
    });
    child.on('error', (e) => reject(e));
  });

// 创建服务，并监听端口
http
  .createServer((requset, response) => {
    if (requset.method === 'POST') {
      if (requset.url === '/webhook') {
        log.success(`Webhook ...`);
        const directory = `${rootDirectory}/repository`;
        const gitPath = `${directory}/.git`;
        const distPath = `${directory}/${config.distName}`;
        const gzipName = `${config.distName}.tar.gz`;
        log.success(`Resolve request from gitlab or github ...`);
        resolveStream(requset)
          .then((buffer) => {
            // 解析github发来的json数据
            const data = JSON.parse(buffer.toString());
            log.success(`Checking ${gitPath} is exists ...`);
            return fs.promises
              .access(gitPath, fs.constants.W_OK)
              .then(() => {
                // 删除已经构建过的文件
                log.success(`Deleting ${distPath} ...`);
                return execProcess(`rm -rf ${distPath}`).then(() => {
                  // 如果.git目录存在，则认为之前发布过，这里就直接更新指定分支即可
                  log.success(`Pulling origin ${config.branch} and merge to local ${config.branch} ...`);
                  // 分支这一块还需要再研究下，万一指定分支在本地不存在，没有跟踪怎么办？
                  return execProcess(`git pull origin ${config.branch}:${config.branch}`, {
                    cwd: directory,
                  });
                });
              })
              .catch(() => {
                // 文件不存在，或上面的then出错，则删除项目目录然后重新clone代码
                log.success(`Deleting ${directory} ...`);
                return execProcess(`rm -rf ${directory}`).then(() => {
                  // 这里可以使用ssh，需要服务器生成ssh-key并且在github上添加可ssh key
                  let gitUrl = data.repository.git_ssh_url;
                  if (!config.useSSH) {
                    // 地址带上用户名和密码，
                    const urlSplit = data.repository.git_http_url.split('//');
                    gitUrl = `${urlSplit[0]}//${encodeUrl(config.username)}:${encodeUrl(config.password)}@${urlSplit[1]}`;
                  }
                  log.success(`Cloning code from ${gitUrl} to ${directory} ...`);
                  return execProcess(`git clone ${gitUrl} ${directory}`, {
                    getInput: (info = '') => {
                      // 这里想使用回显输入用户名和密码的方式，但是git clone有问题，该段不起作用，还是用地址上携带用户名密码的方式
                      if (info.toLowerCase().indexOf('username') !== -1) {
                        return config.username;
                      }
                      if (info.toLowerCase().indexOf('password') !== -1) {
                        return config.password;
                      }
                      return false;
                    },
                  });
                });
              });
          })
          .then(() => {
            // 确保使用指定分支上的代码打包
            log.success(`Changing branch to ${config.branch} ...`);
            return execProcess(`git checkout ${config.branch}`, {
              cwd: directory,
            });
          })
          .then(() => {
            // 安装依赖，这里可以提前设置镜像，也可以检测是否安装yarn，以及是否存在yarn.lock,然后使用yarn安装，后续扩展。。。
            log.success(`Installing dependencies in ${directory} ...`);
            return execProcess('npm install --ignore-scripts', {
              cwd: directory,
            });
          })
          .then(() => {
            // 执行build命令，这里需要制定command
            log.success(`Building project in ${directory} ...`);
            return execProcess(`npm run ${config.buildCMD}`, {
              cwd: directory,
            });
          })
          .then(() => {
            // build之后的文件压缩打包
            log.success(`Packaging ${distPath} to ${distPath}/${gzipName} ...`);
            return execProcess(`tar -zcvf ${gzipName} *`, {
              cwd: distPath,
            });
          })
          .then(() => {
            // 读取打包后的文件流
            log.success(`Reading ${distPath}/${gzipName} to stream ...`);
            return readFileStream(`${distPath}/${gzipName}`);
          })
          .then((fileData) => {
            // 将文件流发送给项目部署的服务器比如Nginx服务器
            log.success('Send file stream to nginx workspace by http ...');
            return sendFileByHttp(config.projectUrl, fileData);
          })
          .then((result) => {
            if (result === 'success') {
              log.success('Deploy success!');
            } else {
              throw new Error(result);
            }
          })
          .catch((e) => {
            log.success(`Deploy faild: ${e.message}`);
          });
        // 响应github或gitlab的请求
        response.end();
        return;
      }
      if (requset.url === '/build') {
        log.success(`Deploy ...`);
        const gzipName = `${config.distName}.tar.gz`;
        // 如果前端Nginx服务器与此服务部署在同一机器，可以使用该服务。
        // 在部署前端代码的服务器也可以运行该服务来接收代码。
        log.success(`Resolve request from repository ...`);
        resolveStream(requset)
          .then((buffer) => {
            // 将接收到的文件流写入文件
            log.success(`Writing package stream to ${config.workspace}/${gzipName} ...`);
            return writeFileStream(buffer, `${config.workspace}/${gzipName}`);
          })
          .then(() => {
            // 删除原有代码（这里可以将其移动到back文件夹以防回退，后面优化）
            log.success(`Deleting ${config.workspace}/* ...`);
            return execProcess(`rm -rf !${gzipName}`, {
              cwd: config.workspace,
            });
          })
          .then(() => {
            // 解压
            log.success(`Unpackaging ${config.workspace}/${gzipName} to ${config.workspace} ...`);
            return execProcess(`tar -zxvf ${config.workspace}/${gzipName}`, {
              cwd: config.workspace,
            });
          })
          .then(() => {
            // 删除压缩包
            log.success(`Deleting ${config.workspace}/${gzipName} ...`);
            return execProcess(`rm -rf ${gzipName}`, {
              cwd: config.workspace,
            });
          })
          .then(() => {
            response.end('success');
          })
          .catch((e) => {
            response.end(e.message);
          });
        return;
      }
    }
    log.success('Deploy faild: Not a gitlab or github post request!');
    response.end('Invalid request!');
  })
  .listen(config.listenPort, () => {
    log.success('Auto deploy server is ready！');
  });
