/*
 * @Author: Huangjs
 * @Date: 2021-05-20 09:41:55
 * @LastEditors: Huangjs
 * @LastEditTime: 2021-05-20 09:42:39
 * @Description: ******
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = {
  // repository: 'http://10.5.13.100:9000/supermarket/system.git',
  // webhook: 'http://10.5.13.101:3000/webhook',
  project: 'http://10.5.13.101:3000/build',
  dist: 'docs',
  workspace: '/home/nginx/html',
  tempPath: '/home/deploy/temp',
  username: 'root',
  password: 'huangjs%40123', // huangjs@123 需要urlencode一下
};

const distFileName = `${config.dist}.tar.gz`;

const resolveStream = (stream) =>
  new Promise((resolve, reject) => {
    const buffers = [];
    stream.on('data', (chunk) => buffers.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(buffers)));
    stream.on('error', (e) => reject(e));
  });
const readFileStream = (filePath) =>
  new Promise((resolve, reject) => {
    // 检查文件是否可读
    fs.access(filePath, fs.constants.R_OK, (error) => {
      if (error) {
        reject(new Error(`Cannot read file:${filePath}`));
        return;
      }
      const readStream = fs.createReadStream(filePath);
      resolveStream(readStream)
        .then((buffer) => resolve(buffer))
        .catch((e) => reject(e));
    });
  });
const writeFileStream = (fileData, filePath) =>
  new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    writeStream.on('open', () => {
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
        resolveStream(response)
          .then((buffer) => resolve(buffer.toString()))
          .catch((e) => reject(e)),
    );
    request.on('error', (e) => reject(e));
    request.write(fileData);
    request.end();
  });

http
  .createServer((requset, response) => {
    if (requset.method === 'POST') {
      if (requset.url === '/webhook') {
        global.console.info(`Receive git push event from github or gitlab ...`);
        resolveStream(requset)
          .then((buffer) => {
            const data = JSON.parse(buffer.toString());
            const urls = data.repository.git_http_url.split('//');
            const gitUrl = `${urls[0]}//${config.username}:${config.password}@${urls[1]}`;
            const directory = path.resolve(config.tempPath);
            global.console.info(`Deleting ${directory} ...`);
            execSync(`rm -rf ${directory}`);
            global.console.info(`Cloning code from ${gitUrl} to ${directory} ...`);
            execSync(`git clone ${gitUrl} ${directory}`);
            global.console.info(`Installing dependencies in ${directory} ...`);
            execSync('npm install', { cwd: directory });
            global.console.info(`Building project in ${directory} ...`);
            execSync('npm run build', { cwd: directory });
            global.console.info(`Packaging ${directory}/${config.dist} to ${directory}/${config.dist}/${distFileName} ...`);
            execSync(`tar -zcvf ${distFileName} *`, { cwd: `${directory}/${config.dist}` });
            global.console.info(`Reading ${directory}/${config.dist}/${distFileName} to stream ...`);
            return readFileStream(`${directory}/${config.dist}/${distFileName}`).then((fileData) => {
              global.console.info('Send file stream to nginx workspace by http ...');
              return sendFileByHttp(config.project, fileData).then((result) => {
                if (result === 'success') {
                  global.console.info('deploy success!');
                } else {
                  throw new Error(result);
                }
              });
            });
          })
          .catch((e) => {
            global.console.info(`deploy faild: ${e.message}`);
          });

        // 返回给github的消息
        response.end();
        return;
      }
      if (requset.url === '/build') {
        global.console.info(`Receive package stream from http ...`);
        const packageName = `${config.workspace}/${distFileName}`;
        resolveStream(requset)
          .then((buffer) => {
            global.console.info(`Writing package stream to ${packageName} ...`);
            return writeFileStream(buffer, packageName).then(() => {
              global.console.info(`Unpackaging ${packageName} to ${config.workspace} ...`);
              execSync(`tar -zxvf ${packageName}`, { cwd: config.workspace });
              global.console.info(`Deleting ${packageName} ...`);
              execSync(`rm -rf ${packageName}`);
              global.console.info('deploy success!');
            });
          })
          .catch((e) => {
            global.console.info(`deploy faild: ${e.message}`);
          });
        response.end('success');
        return;
      }
    }
    global.console.info('deploy faild: Not a gitlab or github post request!');
    response.end('Invalid request!');
  })
  .listen(3000, () => {
    global.console.info('Auto deploy server is ready！');
  });
