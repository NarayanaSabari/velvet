package config

import "errors"

func managementLink(server, user string) Link {
	return Link{Server: server, Organisation: "@management", Project: user}
}

func activeManagementLink(server string) Link {
	return Link{Server: server, Organisation: "@management-active"}
}

var ErrNoManagement = errors.New("no management login on this server; run velvet admin login")

// SaveManagement stores an explicitly consented account credential separately
// from setup credentials and repository keys. It never changes the setup account.
func (k Keys) SaveManagement(server, user, token string) (string, error) {
	if err := ValidateServer(server); err != nil {
		return "", err
	}
	if user == "" || token == "" {
		return "", errors.New("incomplete management identity")
	}
	link := managementLink(server, user)
	old, oldErr := k.LoadStored(link)
	if oldErr != nil && !errors.Is(oldErr, ErrNoKey) {
		return "", oldErr
	}
	where, err := k.Save(link, token)
	if err != nil {
		return "", err
	}
	if err := k.updateFile(activeManagementLink(server), user); err != nil {
		var restore error
		if oldErr == nil {
			_, restore = k.Save(link, old)
		} else {
			restore = k.Delete(link)
		}
		return "", errors.Join(err, restore)
	}
	return where, nil
}

// Management ignores environment bearer tokens and editable repository YAML.
func (k Keys) Management(server, user string) (string, string, error) {
	if err := ValidateServer(server); err != nil {
		return "", "", err
	}
	if user == "" {
		entries, err := k.readFile()
		if err != nil {
			return "", "", err
		}
		user = entries[fileKey(activeManagementLink(server))]
	}
	if user == "" {
		return "", "", ErrNoManagement
	}
	token, err := k.LoadStored(managementLink(server, user))
	if errors.Is(err, ErrNoKey) {
		err = ErrNoManagement
	}
	return user, token, err
}

// DeleteManagement removes only the chosen management credential, not setup or
// project credentials. The caller must first confirm server-side revocation.
func (k Keys) DeleteManagement(server, user string) error {
	if err := ValidateServer(server); err != nil {
		return err
	}
	if err := k.Delete(managementLink(server, user)); err != nil {
		return err
	}
	entries, err := k.readFile()
	if err != nil {
		return err
	}
	if entries[fileKey(activeManagementLink(server))] == user {
		return k.updateFile(activeManagementLink(server), "")
	}
	return nil
}
