// На Windows установщик @tensorflow/tfjs-node кладёт tensorflow.dll не в ту папку,
// где лежит tfjs_binding.node, и модуль падает с "The specified module could not be found".
// Копируем DLL во все папки lib/napi-v*, где есть бинарник.
const fs = require('fs')
const path = require('path')

if (process.platform !== 'win32') process.exit(0)

const root = path.join(__dirname, '..', 'node_modules', '@tensorflow', 'tfjs-node')
const dll = path.join(root, 'deps', 'lib', 'tensorflow.dll')
const libDir = path.join(root, 'lib')

if (!fs.existsSync(dll) || !fs.existsSync(libDir)) process.exit(0)

for (const dir of fs.readdirSync(libDir)) {
  const target = path.join(libDir, dir)
  if (!fs.existsSync(path.join(target, 'tfjs_binding.node'))) continue
  const dest = path.join(target, 'tensorflow.dll')
  // Установщик иногда оставляет вместо файла битую симлинку — заменяем её
  try { fs.unlinkSync(dest) } catch { /* файла ещё нет */ }
  fs.copyFileSync(dll, dest)
  console.log(`[fix-tfjs-node] tensorflow.dll -> ${path.relative(root, target)}`)
}
