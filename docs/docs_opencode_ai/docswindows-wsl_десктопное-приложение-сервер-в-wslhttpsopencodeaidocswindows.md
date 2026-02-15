<!-- Source: https://opencode.ai/docs/windows-wsl -->

## [Десктопное приложение + сервер в WSL](https://opencode.ai/docs/windows-wsl#%D0%B4%D0%B5%D1%81%D0%BA%D1%82%D0%BE%D0%BF%D0%BD%D0%BE%D0%B5-%D0%BF%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5--%D1%81%D0%B5%D1%80%D0%B2%D0%B5%D1%80-%D0%B2-wsl)
Если вы предпочитаете opencode Desktop, но хотите запускать сервер в WSL:
  1. **Запустите сервер в WSL** с параметром `--hostname 0.0.0.0`, чтобы разрешить внешние подключения:
Окно терминала```


opencodeserve--hostname0.0.0.0--port4096


```

  2. **Подключите десктопное приложение** к `http://localhost:4096`


Если в вашей конфигурации `localhost` не работает, используйте IP-адрес WSL (выполните в WSL: `hostname -I`) и подключайтесь по `http://<wsl-ip>:4096`.
При использовании `--hostname 0.0.0.0` задайте `OPENCODE_SERVER_PASSWORD`, чтобы защитить сервер.
Окно терминала```


OPENCODE_SERVER_PASSWORD=your-passwordopencodeserve--hostname0.0.0.0


```

* * *

