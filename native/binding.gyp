{
  "targets": [
    {
      "target_name": "windows",
      "sources": ["windows.c"],
      "libraries": ["advapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions!": ["-std:c++20"],
          "LanguageStandard_C": "stdc17"
        }
      }
    }
  ]
}
