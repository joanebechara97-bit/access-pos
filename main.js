const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const http = require('http')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('use-gl', 'swiftshader')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-software-rasterizer')

let mainWindow
let server
const port = process.env.PORT || '10000'
const serverUrl = `http://localhost:${port}`

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadURL(serverUrl)
}

function waitForServer(retries = 40) {
  return new Promise((resolve, reject) => {
    const check = (left) => {
      const req = http.get(serverUrl, (res) => {
        res.resume()
        resolve()
      })

      req.on('error', () => {
        if (left <= 0) {
          reject(new Error(`Server did not start at ${serverUrl}`))
          return
        }

        setTimeout(() => check(left - 1), 250)
      })

      req.setTimeout(1000, () => {
        req.destroy()
      })
    }

    check(retries)
  })
}

app.whenReady().then(async () => {

  server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: port },
    shell: true,
    windowsHide: true
  })

  server.stdout.on('data', data => console.log(data.toString()))
  server.stderr.on('data', data => console.error(data.toString()))

  try {
    await waitForServer()
    createWindow()
  } catch (error) {
    console.error(error.message)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (server) server.kill()
  if (process.platform !== 'darwin') app.quit()
})
