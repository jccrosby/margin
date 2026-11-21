#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <aclapi.h>
#include <winternl.h>
#include <node_api.h>
#include <uv.h>
#include <stdbool.h>
#include <stdint.h>
#include <wchar.h>

#ifndef OBJ_CASE_INSENSITIVE
#define OBJ_CASE_INSENSITIVE 0x40
#endif
#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x1000
#endif

#define PATH_CAPACITY 32768
#define NT_OPEN 1
#define NT_DIRECTORY 0x00000001
#define NT_SYNC_NONALERT 0x00000020
#define NT_NON_DIRECTORY 0x00000040
#define NT_OPEN_REPARSE 0x00200000

typedef NTSTATUS (NTAPI *nt_create_file_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef ULONG (NTAPI *nt_status_to_error_fn)(NTSTATUS);

static nt_create_file_fn nt_create_file;
static nt_status_to_error_fn nt_status_to_error;

static napi_value integer(napi_env env, int value) {
  napi_value result;
  napi_create_int32(env, value, &result);
  return result;
}

static napi_value error(napi_env env) {
  DWORD code = GetLastError();
  return integer(env, -(int)(code ? code : ERROR_ACCESS_DENIED));
}

static bool path_arg(napi_env env, napi_value arg, wchar_t path[PATH_CAPACITY]) {
  size_t length, copied;
  return napi_get_value_string_utf16(env, arg, NULL, 0, &length) == napi_ok &&
    length < PATH_CAPACITY &&
    napi_get_value_string_utf16(env, arg, (char16_t *)path, PATH_CAPACITY, &copied) == napi_ok &&
    copied == wcslen(path);
}

static HANDLE handle_arg(napi_env env, napi_value arg) {
  int fd;
  if (napi_get_value_int32(env, arg, &fd) != napi_ok || fd < 0) return INVALID_HANDLE_VALUE;
  return uv_get_osfhandle(fd);
}

static napi_value descriptor(napi_env env, HANDLE handle) {
  if (handle == INVALID_HANDLE_VALUE) return error(env);
  int fd = uv_open_osfhandle(handle);
  if (fd >= 0) return integer(env, fd);
  CloseHandle(handle);
  return integer(env, -ERROR_TOO_MANY_OPEN_FILES);
}

static bool canonical_path(HANDLE handle, wchar_t result[PATH_CAPACITY]) {
  DWORD count = GetFinalPathNameByHandleW(handle, result, PATH_CAPACITY, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (count > 6 && count < PATH_CAPACITY && wcsncmp(result, L"\\\\?\\", 4) == 0 && result[5] == L':' &&
      result[6] == L'\\') {
    memmove(result, result + 4, (count - 3) * sizeof(wchar_t));
    return true;
  }
  SetLastError(ERROR_NOT_SUPPORTED);
  return false;
}

static bool valid_handle(HANDLE handle, bool directory, BY_HANDLE_FILE_INFORMATION *info) {
  if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, info)) {
    SetLastError(ERROR_NOT_SUPPORTED);
    return false;
  }
  if (info->dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    SetLastError(ERROR_CANT_ACCESS_FILE);
    return false;
  }
  if (((info->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) {
    SetLastError(ERROR_DIRECTORY);
    return false;
  }
  if (!directory && info->nNumberOfLinks != 1) {
    SetLastError(ERROR_CANT_ACCESS_FILE);
    return false;
  }
  return true;
}

static HANDLE volume_root(const wchar_t *path) {
  if (!(((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && path[2] == L'\\')) {
    SetLastError(ERROR_INVALID_NAME);
    return INVALID_HANDLE_VALUE;
  }
  wchar_t drive[] = { path[0], L':', L'\\', L'\0' };
  if (GetDriveTypeW(drive) != DRIVE_FIXED) {
    SetLastError(ERROR_NOT_SUPPORTED);
    return INVALID_HANDLE_VALUE;
  }
  HANDLE handle = CreateFileW(drive, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return handle;
  BY_HANDLE_FILE_INFORMATION info;
  wchar_t format[32];
  if (!valid_handle(handle, true, &info) ||
      !GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, NULL, format, ARRAYSIZE(format)) ||
      wcscmp(format, L"NTFS") != 0) {
    CloseHandle(handle);
    SetLastError(ERROR_NOT_SUPPORTED);
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static HANDLE open_component(HANDLE root, wchar_t *component, bool directory, bool exact, DWORD volume) {
  size_t length = wcslen(component);
  if (!length || length > 255 || wcscmp(component, L".") == 0 || wcscmp(component, L"..") == 0 ||
      wcspbrk(component, L"\\/:") != NULL) {
    SetLastError(ERROR_INVALID_NAME);
    return INVALID_HANDLE_VALUE;
  }
  UNICODE_STRING name = { (USHORT)(length * sizeof(wchar_t)), (USHORT)(length * sizeof(wchar_t)), component };
  OBJECT_ATTRIBUTES object = {
    sizeof(object), root, &name, OBJ_DONT_REPARSE | (exact ? 0 : OBJ_CASE_INSENSITIVE), NULL, NULL
  };
  IO_STATUS_BLOCK status_block;
  HANDLE handle;
  const ACCESS_MASK access = directory
    ? FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE
    : FILE_GENERIC_READ;
  NTSTATUS status = nt_create_file(&handle, access, &object, &status_block, NULL, 0,
    FILE_SHARE_READ | FILE_SHARE_WRITE | (directory ? 0 : FILE_SHARE_DELETE), NT_OPEN,
    NT_SYNC_NONALERT | NT_OPEN_REPARSE | (directory ? NT_DIRECTORY : NT_NON_DIRECTORY), NULL, 0);
  if (status < 0) {
    SetLastError(nt_status_to_error(status));
    return INVALID_HANDLE_VALUE;
  }

  BY_HANDLE_FILE_INFORMATION info;
  DWORD failure = ERROR_SUCCESS;
  if (!valid_handle(handle, directory, &info)) failure = GetLastError();
  else if (info.dwVolumeSerialNumber != volume) failure = ERROR_NOT_SAME_DEVICE;
  else if (exact) {
    wchar_t full[PATH_CAPACITY];
    if (!canonical_path(handle, full) || wcscmp(wcsrchr(full, L'\\') + 1, component) != 0) {
      failure = ERROR_FILE_NOT_FOUND;
    }
  }
  if (!failure) return handle;
  CloseHandle(handle);
  SetLastError(failure);
  return INVALID_HANDLE_VALUE;
}

static HANDLE walk(HANDLE root, wchar_t *path, wchar_t separator, bool directory, bool exact) {
  BY_HANDLE_FILE_INFORMATION info;
  if (!valid_handle(root, true, &info)) return INVALID_HANDLE_VALUE;
  // Hold each directory until the final open to block ancestor renames.
  size_t capacity = wcslen(path) / 2 + 1;
  HANDLE *ancestors = HeapAlloc(GetProcessHeap(), 0, capacity * sizeof(HANDLE));
  if (!ancestors) {
    SetLastError(ERROR_OUTOFMEMORY);
    return INVALID_HANDLE_VALUE;
  }
  size_t count = 0;
  HANDLE opened = INVALID_HANDLE_VALUE;
  for (wchar_t *segment = path; ; ) {
    wchar_t *next = wcschr(segment, separator);
    if (next) *next = L'\0';
    HANDLE current = count ? ancestors[count - 1] : root;
    opened = open_component(current, segment, next || directory, exact, info.dwVolumeSerialNumber);
    if (!next || opened == INVALID_HANDLE_VALUE) break;
    ancestors[count++] = opened;
    segment = next + 1;
  }
  DWORD failure = GetLastError();
  while (count) CloseHandle(ancestors[--count]);
  HeapFree(GetProcessHeap(), 0, ancestors);
  SetLastError(failure);
  return opened;
}

static napi_value verify_volume(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  wchar_t path[PATH_CAPACITY];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !path_arg(env, args[0], path)) return integer(env, -ERROR_INVALID_NAME);
  HANDLE root = volume_root(path);
  if (root == INVALID_HANDLE_VALUE) return error(env);
  CloseHandle(root);
  return integer(env, 0);
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  wchar_t path[PATH_CAPACITY];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !path_arg(env, args[0], path)) return integer(env, -ERROR_INVALID_NAME);
  HANDLE root = volume_root(path);
  if (root == INVALID_HANDLE_VALUE || !path[3]) return descriptor(env, root);
  HANDLE directory = walk(root, path + 3, L'\\', true, false);
  DWORD failure = GetLastError();
  CloseHandle(root);
  SetLastError(failure);
  return descriptor(env, directory);
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  wchar_t path[PATH_CAPACITY];
  bool directory, exact;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 4 || !path_arg(env, args[1], path) ||
      napi_get_value_bool(env, args[2], &directory) != napi_ok ||
      napi_get_value_bool(env, args[3], &exact) != napi_ok) return integer(env, -ERROR_INVALID_PARAMETER);
  HANDLE root = handle_arg(env, args[0]);
  return descriptor(env, walk(root, path, L'/', directory, exact));
}

static napi_value entries(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1) return integer(env, -ERROR_INVALID_PARAMETER);
  HANDLE handle = handle_arg(env, args[0]);
  ULONG_PTR buffer[8192];
  napi_create_array(env, &result);
  uint32_t index = 0;
  FILE_INFO_BY_HANDLE_CLASS kind = FileIdBothDirectoryRestartInfo;
  while (GetFileInformationByHandleEx(handle, kind, buffer, sizeof(buffer))) {
    FILE_ID_BOTH_DIR_INFO *item = (FILE_ID_BOTH_DIR_INFO *)buffer;
    kind = FileIdBothDirectoryInfo;
    for (;;) {
      wchar_t *name = item->FileName;
      int length = (int)(item->FileNameLength / sizeof(wchar_t));
      if (!(item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
          !(length == 1 && name[0] == L'.') && !(length == 2 && name[0] == L'.' && name[1] == L'.')) {
        char utf8[1024];
        int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, length, utf8, sizeof(utf8), NULL, NULL);
        if (bytes > 0) {
          napi_value row, path, type;
          napi_create_array_with_length(env, 2, &row);
          napi_create_buffer_copy(env, bytes, utf8, NULL, &path);
          napi_create_string_utf8(env, item->FileAttributes & FILE_ATTRIBUTE_DIRECTORY ? "directory" : "file",
            NAPI_AUTO_LENGTH, &type);
          napi_set_element(env, row, 0, path);
          napi_set_element(env, row, 1, type);
          napi_set_element(env, result, index++, row);
        }
      }
      if (!item->NextEntryOffset) break;
      item = (FILE_ID_BOTH_DIR_INFO *)((BYTE *)item + item->NextEntryOffset);
    }
  }
  DWORD code = GetLastError();
  if (code == ERROR_NO_MORE_FILES || code == ERROR_FILE_NOT_FOUND) return result;
  return error(env);
}

static napi_value entry_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], result;
  wchar_t path[PATH_CAPACITY];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1) return integer(env, -ERROR_INVALID_PARAMETER);
  if (!canonical_path(handle_arg(env, args[0]), path)) return error(env);
  napi_create_string_utf16(env, (char16_t *)path, NAPI_AUTO_LENGTH, &result);
  return result;
}

static bool current_user(PSID sid) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD size;
  ULONG_PTR buffer[128];
  BOOL ok = GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &size);
  CloseHandle(token);
  return ok && CopySid(SECURITY_MAX_SID_SIZE, sid, ((TOKEN_USER *)buffer)->User.Sid);
}

static bool user_owns_new_files(void) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, &token)) return false;
  ULONG_PTR user[128], owner[128];
  DWORD size;
  BOOL ok = GetTokenInformation(token, TokenUser, user, sizeof(user), &size) &&
    GetTokenInformation(token, TokenOwner, owner, sizeof(owner), &size);
  if (ok) {
    TOKEN_OWNER expected = { ((TOKEN_USER *)user)->User.Sid };
    // SQLite and Node create files with the process token's default owner.
    if (!EqualSid(expected.Owner, ((TOKEN_OWNER *)owner)->Owner)) {
      ok = SetTokenInformation(token, TokenOwner, &expected, sizeof(expected));
    }
  }
  CloseHandle(token);
  return ok != FALSE;
}

static bool trusted(PSID sid, PSID user) {
  return sid && IsValidSid(sid) && (EqualSid(sid, user) ||
    IsWellKnownSid(sid, WinLocalSystemSid) || IsWellKnownSid(sid, WinBuiltinAdministratorsSid));
}

static bool private_handle(HANDLE handle, bool ancestor) {
  DWORD user[SECURITY_MAX_SID_SIZE / sizeof(DWORD)];
  if (!current_user(user)) return false;
  BY_HANDLE_FILE_INFORMATION info;
  if (!GetFileInformationByHandle(handle, &info)) return false;
  bool directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!valid_handle(handle, directory, &info) || (ancestor && !directory)) return false;

  PSID owner;
  PACL dacl;
  PSECURITY_DESCRIPTOR security;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &dacl, NULL, &security) != ERROR_SUCCESS) return false;
  bool safe = dacl && IsValidAcl(dacl) &&
    (ancestor ? trusted(owner, user) : owner && IsValidSid(owner) && EqualSid(owner, user));
  bool inheritable_user = false;
  const DWORD replacement = DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER |
    FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
  GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
  for (WORD index = 0; safe && index < dacl->AceCount; index++) {
    void *entry;
    if (!GetAce(dacl, index, &entry)) {
      safe = false;
      break;
    }
    ACE_HEADER *header = entry;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE || (ancestor && (header->AceFlags & INHERIT_ONLY_ACE))) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      safe = false;
      break;
    }
    ACCESS_ALLOWED_ACE *allow = entry;
    PSID sid = &allow->SidStart;
    DWORD mask = allow->Mask;
    MapGenericMask(&mask, &mapping);
    if (!trusted(sid, user) && (!ancestor || (mask & replacement))) safe = false;
    const BYTE inherit = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
    if ((header->AceFlags & (inherit | NO_PROPAGATE_INHERIT_ACE)) == inherit &&
        IsValidSid(sid) && EqualSid(sid, user) && (mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS) {
      inheritable_user = true;
    }
  }
  LocalFree(security);
  return safe && (ancestor || !directory || inheritable_user);
}

static napi_value private_access(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], result;
  bool ancestor;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_value_bool(env, args[1], &ancestor) != napi_ok) {
    return integer(env, -ERROR_INVALID_PARAMETER);
  }
  napi_get_boolean(env, private_handle(handle_arg(env, args[0]), ancestor), &result);
  return result;
}

static napi_value create_private_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  wchar_t path[PATH_CAPACITY];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 1 || !path_arg(env, args[0], path)) return integer(env, -ERROR_INVALID_NAME);

  DWORD user[SECURITY_MAX_SID_SIZE / sizeof(DWORD)];
  DWORD acl_buffer[128];
  PACL acl = (PACL)acl_buffer;
  SECURITY_DESCRIPTOR security;
  if (!current_user(user) || !InitializeAcl(acl, sizeof(acl_buffer), ACL_REVISION) ||
      !AddAccessAllowedAceEx(acl, ACL_REVISION, CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE, FILE_ALL_ACCESS, user) ||
      !InitializeSecurityDescriptor(&security, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&security, user, FALSE) ||
      !SetSecurityDescriptorDacl(&security, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&security, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return error(env);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), &security, FALSE };
  return CreateDirectoryW(path, &attributes) ? integer(env, 0) : error(env);
}

static napi_value publish(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  wchar_t from[PATH_CAPACITY], to[PATH_CAPACITY];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || !path_arg(env, args[0], from) || !path_arg(env, args[1], to)) return integer(env, -ERROR_INVALID_NAME);
  return MoveFileExW(from, to, MOVEFILE_WRITE_THROUGH) ? integer(env, 0) : error(env);
}

NAPI_MODULE_INIT() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  nt_create_file = (nt_create_file_fn)(void *)GetProcAddress(ntdll, "NtCreateFile");
  nt_status_to_error = (nt_status_to_error_fn)(void *)GetProcAddress(ntdll, "RtlNtStatusToDosError");
  if (!nt_create_file || !nt_status_to_error || !user_owns_new_files()) {
    napi_throw_error(env, NULL, "Margin requires Windows NTFS file operations.");
    return NULL;
  }
  const napi_property_descriptor methods[] = {
    { .utf8name = "verifyVolume", .method = verify_volume },
    { .utf8name = "openDirectory", .method = open_directory },
    { .utf8name = "openEntry", .method = open_entry },
    { .utf8name = "entries", .method = entries },
    { .utf8name = "entryPath", .method = entry_path },
    { .utf8name = "privateAccess", .method = private_access },
    { .utf8name = "createPrivateDirectory", .method = create_private_directory },
    { .utf8name = "publish", .method = publish }
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}
