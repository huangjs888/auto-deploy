/*
 * @Author: Huangjs
 * @Date: 2021-05-19 15:05:25
 * @LastEditors: Huangjs
 * @LastEditTime: 2021-05-20 09:41:03
 * @Description: ******
 */
const { exec } = require('child_process');

// 测试1
const child = exec('npm login');
let inputType = 0;
child.stdout.on('data', (data) => {
  console.log(data.toString());
  if (inputType === 0) {
    inputType = 1;
    child.stdin.write('huangjs@888\n');
  } else if (inputType === 1) {
    inputType = 2;
    child.stdin.write('xxxxxxxx\n');
  } else if (inputType === 2) {
    inputType = 3;
    child.stdin.write('xxxxxxxx@qq.com\n');
  }
});
child.stderr.on('data', (data) => {
  console.log(data.toString());
});
child.on('close', (code) => {
  console.log(`exit ${code}`);
  child.stdin.end();
});
child.on('error', (e) => {
  console.log('error:' + e.message);
});
// 测试2
var subProcess = exec('npm login');
subProcess.on('error', function () {
  console.log('error');
  console.log(arguments);
});
subProcess.on('close', (code) => {
  if (code != 0) {
    console.log(`子进程退出码：${code}`);
  } else {
    console.log('登录成功');
  }
  process.stdin.end();
});
subProcess.stdin.on('end', () => {
  process.stdout.write('end');
});
subProcess.on('error', (e) => {
  console.log('error:' + e.message);
});

subProcess.stdout.on('data', onData);
subProcess.stderr.on('data', onData);

function onData(data) {
  process.stdout.write('# ' + data);
  process.stdin.on('data', (input) => {
    input = input.toString().trim();
    console.log('input:' + input);
    subProcess.stdin.write(input + '\n');
  });
}
